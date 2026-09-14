#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';

const envFile = process.env.JANUS_VOICE_ENV?.trim() || '.env.voice.local';
loadEnvFile(envFile);

const sttUrl = loopbackUrl(requireEnv('JANUS_STT_BASE_URL'), 'JANUS_STT_BASE_URL');
const ttsUrl = loopbackUrl(requireEnv('JANUS_TTS_BASE_URL'), 'JANUS_TTS_BASE_URL');
const whisperBin = requireLocalFile('WHISPER_SERVER_BIN');
const whisperModel = requireLocalFile('WHISPER_MODEL');
const voiceConfig = requireLocalFile('JANUS_QWEN_VOICE_CONFIG');
const voiceId = requireEnv('JANUS_VOICE_ID');
const qwenPython = process.env.JANUS_QWEN_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
const runtimePort = numericPort(process.env.PORT?.trim() || '8787', 'PORT');

validateVoiceConfig(voiceConfig, voiceId);

const children = [];
let shuttingDown = false;

try {
  const whisper = startProcess('whisper.cpp', whisperBin, [
    '-m', whisperModel,
    '--host', sttUrl.hostname,
    '--port', portOf(sttUrl, 8080),
    '--no-timestamps',
  ], process.env);
  children.push(whisper);
  await waitForPort(sttUrl.hostname, Number(portOf(sttUrl, 8080)), 30_000, whisper);

  const qwenEnv = {
    ...process.env,
    JANUS_QWEN_VOICE_CONFIG: voiceConfig,
    JANUS_QWEN_HOST: ttsUrl.hostname,
    JANUS_QWEN_PORT: portOf(ttsUrl, 8090),
  };
  const qwen = startProcess('qwen3-tts', qwenPython, ['sidecars/qwen3_tts_server.py'], qwenEnv);
  children.push(qwen);
  await waitForJson(new URL('/health', ttsUrl).toString(), 120_000, qwen);

  const runtimeEnv = {
    ...process.env,
    PORT: String(runtimePort),
    JANUS_STT_BASE_URL: sttUrl.toString().replace(/\/$/, ''),
    JANUS_TTS_BASE_URL: ttsUrl.toString().replace(/\/$/, ''),
    JANUS_VOICE_ID: voiceId,
  };
  const runtime = startProcess('janus-core', process.execPath, ['--import', 'tsx', 'apps/runtime/server.ts'], runtimeEnv);
  children.push(runtime);

  const health = await waitForJson(`http://127.0.0.1:${runtimePort}/health`, 30_000, runtime);
  if (health?.voice?.streaming?.state !== 'available') {
    throw new Error(`Janus runtime started but voice streaming is not available: ${JSON.stringify(health?.voice?.streaming ?? {})}`);
  }

  console.log(`JANUS local voice ready: http://127.0.0.1:${runtimePort}`);
  console.log(`Voice ID: ${voiceId}`);
  console.log('Press Ctrl+C to stop the local voice stack.');

  await new Promise((resolvePromise) => {
    const stop = () => resolvePromise(undefined);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    runtime.once('exit', stop);
  });
} catch (error) {
  console.error(`JANUS local voice startup failed: ${compactError(error)}`);
  process.exitCode = 1;
} finally {
  await shutdownAll();
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Copy .env.voice.example to .env.voice.local and configure it locally.`);
  return value;
}

function requireLocalFile(name) {
  const raw = requireEnv(name);
  const path = resolve(raw);
  if (!existsSync(path)) throw new Error(`${name} does not exist locally: ${path}`);
  return path;
}

function loopbackUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must use http or https`);
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  if (!loopback) throw new Error(`${name} must use loopback for the local voice supervisor`);
  return url;
}

function portOf(url, fallback) {
  return url.port || String(fallback);
}

function numericPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return port;
}

function validateVoiceConfig(path, voiceId) {
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const voices = payload?.voices;
  if (!voices || typeof voices !== 'object' || Array.isArray(voices)) throw new Error('voice config must contain a voices object');
  const selected = voices[voiceId];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error(`JANUS_VOICE_ID '${voiceId}' is not present in the local voice config`);

  const modelPath = resolve(String(selected.model_path ?? ''));
  if (!selected.model_path || !existsSync(modelPath)) throw new Error(`voice '${voiceId}' model_path does not exist locally`);
  if (selected.mode === 'voice_clone') {
    const refAudio = resolve(String(selected.ref_audio ?? ''));
    if (!selected.ref_audio || !existsSync(refAudio)) throw new Error(`voice '${voiceId}' clone ref_audio does not exist locally`);
    if (!selected.x_vector_only_mode && !String(selected.ref_text ?? '').trim()) {
      throw new Error(`voice '${voiceId}' requires ref_text unless x_vector_only_mode is true`);
    }
  }
}

function startProcess(label, command, args, env) {
  console.log(`Starting ${label}…`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.once('error', (error) => {
    if (!shuttingDown) console.error(`${label} process error: ${compactError(error)}`);
  });
  return child;
}

async function waitForPort(host, port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    assertChildAlive(child);
    try {
      await new Promise((resolvePromise, reject) => {
        const socket = connect({ host, port });
        socket.setTimeout(750);
        socket.once('connect', () => {
          socket.destroy();
          resolvePromise(undefined);
        });
        socket.once('timeout', () => {
          socket.destroy();
          reject(new Error('connect timeout'));
        });
        socket.once('error', reject);
      });
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error(`timeout waiting for ${host}:${port}`);
}

async function waitForJson(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    assertChildAlive(child);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

function assertChildAlive(child) {
  if (child.exitCode !== null) throw new Error(`child process exited early with code ${child.exitCode}`);
  if (child.signalCode !== null) throw new Error(`child process exited early from ${child.signalCode}`);
}

async function shutdownAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
  }
  await Promise.race([
    Promise.all(children.map((child) => new Promise((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolvePromise(undefined);
      child.once('exit', () => resolvePromise(undefined));
    }))),
    delay(2_000),
  ]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function compactError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
