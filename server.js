/**
 * NuStack Runner Server
 * Runs on Railway — executes claude CLI jobs dispatched from the Vercel app.
 *
 * POST /run        — start a claude run (SSE stream)
 * GET  /health     — health check
 * GET  /status     — list running jobs
 */

require('dotenv').config();
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const RUNNER_SECRET = process.env.RUNNER_SECRET ?? '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const PORT = process.env.PORT ?? 3001;
const MAX_GLOBAL_CONCURRENT = 3;
const REPOS_DIR = process.env.REPOS_DIR ?? '/repos';

// Track active processes in-memory
const activeProcs = new Map(); // runId → ChildProcess

// ─── Auth middleware ───
function requireSecret(req, res, next) {
  const key = req.headers['x-runner-secret'];
  if (!RUNNER_SECRET || key !== RUNNER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Ensure repo is cloned and up to date ───
function syncRepo(githubRepo, localPath, send) {
  if (!githubRepo) {
    // No GitHub repo configured — just verify localPath exists
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local path does not exist: ${localPath}. Set githubRepo on the project to auto-clone.`);
    }
    return;
  }

  const tokenUrl = GITHUB_TOKEN
    ? `https://${GITHUB_TOKEN}@github.com/${githubRepo}.git`
    : `https://github.com/${githubRepo}.git`;

  if (!fs.existsSync(localPath)) {
    // Clone
    send('text', { text: `Cloning ${githubRepo}...\n` });
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    execSync(`git clone "${tokenUrl}" "${localPath}"`, { stdio: 'pipe' });
    send('text', { text: `Cloned to ${localPath}\n` });
  } else {
    // Pull latest
    send('text', { text: `Pulling latest ${githubRepo}...\n` });
    execSync(`git -C "${localPath}" pull --rebase`, { stdio: 'pipe' });
    send('text', { text: `Up to date.\n` });
  }
}

// ─── Health check ───
app.get('/health', (req, res) => {
  res.json({ ok: true, active: activeProcs.size, reposDir: REPOS_DIR });
});

// ─── Status ───
app.get('/status', requireSecret, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, project_slug, command, status, score, started_at, completed_at
     FROM audit_run
     WHERE status = 'running'
     ORDER BY started_at DESC`
  );
  res.json({ running: rows, active: activeProcs.size });
});

// ─── Run ───
app.post('/run', requireSecret, async (req, res) => {
  const { runId, projectSlug, githubRepo, localPath: rawLocalPath, command, prompt } = req.body;

  if (!runId || !prompt) {
    return res.status(400).json({ error: 'Missing runId or prompt' });
  }

  // Enforce global concurrent limit
  if (activeProcs.size >= MAX_GLOBAL_CONCURRENT) {
    return res.status(429).json({
      error: `Maximum of ${MAX_GLOBAL_CONCURRENT} concurrent runners reached.`
    });
  }

  // Derive local path — if githubRepo is set, use REPOS_DIR/<slug>
  const localPath = githubRepo
    ? path.join(REPOS_DIR, projectSlug)
    : rawLocalPath;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send('start', { runId, projectSlug, command, prompt });

  // Sync repo (clone or pull)
  try {
    syncRepo(githubRepo, localPath, send);
  } catch (err) {
    const msg = err.message;
    send('error', { error: `Repo sync failed: ${msg}` });
    await pool.query(
      `UPDATE audit_run SET status = 'failed', output = $1, completed_at = NOW() WHERE id = $2`,
      [msg, runId]
    ).catch(console.error);
    res.end();
    return;
  }

  let fullOutput = '';

  // Spawn claude in the project directory
  const proc = spawn(
    'claude',
    ['-p', prompt, '--output-format', 'stream-json', '--verbose'],
    {
      cwd: localPath,
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/home/${process.env.USER ?? 'runner'}/.npm/bin:/root/.npm/bin`,
      },
      shell: false,
    }
  );

  activeProcs.set(runId, proc);

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullOutput += text;

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        const type = evt.type;

        if (type === 'assistant') {
          const content = evt.message;
          if (content?.content) {
            for (const block of content.content) {
              if (block.type === 'text' && block.text) {
                send('text', { text: block.text });
              }
              if (block.type === 'tool_use') {
                send('tool_start', { tool: block.name, input: block });
              }
            }
          }
        } else if (type === 'tool_result') {
          send('tool_result', { tool: 'tool', result: evt });
        } else if (type === 'result') {
          send('result', { output: evt.result, cost: evt.total_cost_usd });
        } else {
          send('event', { type, data: evt });
        }
      } catch {
        send('text', { text: trimmed });
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    fullOutput += `[stderr] ${text}`;
    send('stderr', { text });
  });

  proc.on('error', async (err) => {
    activeProcs.delete(runId);
    const errMsg = err.message.includes('ENOENT')
      ? 'claude CLI not found. Run: npm install -g @anthropic-ai/claude-code'
      : err.message;

    send('error', { error: errMsg });

    await pool.query(
      `UPDATE audit_run SET status = 'failed', output = $1, completed_at = NOW() WHERE id = $2`,
      [errMsg, runId]
    ).catch(console.error);

    res.end();
  });

  proc.on('close', async (code) => {
    activeProcs.delete(runId);
    const status = code === 0 ? 'completed' : 'failed';

    // Extract score
    const scoreMatch = fullOutput.match(/(?:score[:\s]+|health[:\s]+)?(\d{1,3})\s*\/\s*100/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

    // Update audit_run
    await pool.query(
      `UPDATE audit_run SET status = $1, output = $2, score = $3, completed_at = NOW() WHERE id = $4`,
      [status, fullOutput, score, runId]
    ).catch(console.error);

    // Update project last audit score
    if (command === 'audit' && score !== null) {
      await pool.query(
        `UPDATE runner_project SET last_audit_score = $1, last_audit_at = NOW() WHERE slug = $2`,
        [score, projectSlug]
      ).catch(console.error);
    }

    send('done', { runId, exitCode: code, status, score });
    res.end();
  });

  // If client disconnects, kill the process
  req.on('close', () => {
    if (activeProcs.has(runId)) {
      proc.kill('SIGTERM');
      activeProcs.delete(runId);
    }
  });
});

app.listen(PORT, () => {
  console.log(`NuStack Runner listening on port ${PORT}`);
  console.log(`Repos dir: ${REPOS_DIR}`);
  console.log(`Active procs: ${activeProcs.size}`);
});
