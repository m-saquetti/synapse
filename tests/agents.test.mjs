import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { subscriptionEnvironment, safeDiagnostic, classifyFailure, buildArguments, createEventCollector, runAgent, runLocalProcess, resolveWindowsExecutable } from '../lib/agents.mjs';
import { normalizeSettings } from '../lib/settings.mjs';

test('project execution keeps automatic review and passes the selected models exactly',()=>{
  const settings={access:'project',internet:true,codexModel:'gpt-6-astra',claudeModel:'claude-opus-5-5',effort:'high'};
  const codex=buildArguments('codex','/tmp/project',settings),claude=buildArguments('claude','/tmp/project',settings);
  assert.ok(codex.includes('--approve-for-me'));
  assert.ok(codex.includes('web_search="live"'));
  assert.equal(codex[codex.indexOf('--model')+1],'gpt-6-astra');
  assert.ok(codex.some((v,i)=>v==='--enable'&&codex[i+1]==='code_mode_host'));
  assert.equal(claude[claude.indexOf('--model')+1],'claude-opus-5-5');
  assert.equal(claude[claude.indexOf('--permission-mode')+1],'auto');
  assert.ok(claude.includes('--restricted'));
  assert.match(claude[claude.indexOf('--tools')+1],/Write.*Bash.*WebFetch/);
  assert.ok(![...codex,...claude].some(v=>/bypass|skip-permissions|fallback-model/.test(v)));
});
test('chat web mode enables only web tools; computer mode retains review',()=>{
  const web=buildArguments('claude','/tmp',{access:'chat',internet:true});
  assert.equal(web[web.indexOf('--tools')+1],'WebSearch,WebFetch');
  const computer=buildArguments('claude','/tmp',{access:'computer'});
  assert.equal(computer[computer.indexOf('--permission-mode')+1],'auto');
  assert.ok(!computer.includes('--restricted'));
  assert.ok(!computer.includes('WebFetch'));
  assert.ok(buildArguments('codex','/tmp',{internet:true}).includes('code_mode_host'));
});
test('invalid model identifiers and settings are rejected instead of becoming flags',()=>{
  for(const value of [{codexModel:'--help'},{claudeModel:'x --dangerously-skip-permissions'},{timeoutMinutes:61},{internet:'false'},{access:'full'},{workspace:'relative'},{unexpected:true}]) assert.throws(()=>normalizeSettings(value));
  assert.equal(normalizeSettings({codexModel:'provider.model-1:stable'}).codexModel,'provider.model-1:stable');
});
test('tool events report commands and failures without leaking tool outputs or reasoning',()=>{
  const activities=[],c=createEventCollector('codex',{onActivity:v=>activities.push(v)});
  c.accept(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'node test.mjs'}}));
  c.accept(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'node test.mjs',exit_code:1,aggregated_output:'private data'}}));
  assert.equal(activities[1].status,'failed');assert.equal(activities[0].detail,'node test.mjs');
  assert.ok(!JSON.stringify(activities).includes('private data'));
});

test('Explorer launch discovers native clients outside PATH and follows versioned updates', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mesa-discovery-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: join(profile, 'AppData', 'Local'), USERPROFILE: profile, Path: '' };
  const bin = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  async function fixture(path, timestamp) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture only');
    await utimes(path, timestamp, timestamp);
    return path;
  }
  await fixture(join(bin, 'not-a-release', 'codex.exe'), 400);
  await fixture(join(bin, '1111111111111111', 'codex.exe'), 100);
  const newest = await fixture(join(bin, '2222222222222222', 'codex.exe'), 200);
  await mkdir(join(bin, '3333333333333333'), { recursive: true });
  assert.equal(await resolveWindowsExecutable('codex', env), newest);
  const claude = await fixture(join(profile, '.local', 'bin', 'claude.exe'), 100);
  assert.equal(await resolveWindowsExecutable('claude', env), claude);
  const pathBin = join(profile, 'preferred install');
  const preferred = await fixture(join(pathBin, 'codex.exe'), 100);
  assert.equal(await resolveWindowsExecutable('codex', { ...env, Path: `"${pathBin}"` }), preferred);
});

test('subscription environment removes billing overrides and inherited agent IPC', () => {
  const env = subscriptionEnvironment({ PATH: 'path', USERPROFILE: 'profile', CODEX_HOME: 'auth-home', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', AWS_ACCESS_KEY_ID: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', CODEX_PERMISSION_PROFILE: 'unsafe', CODEX_APP_TOOLS_PIPE_PATH: 'pipe', CODEX_THREAD_ID: 'parent', NODE_OPTIONS: '--inspect' });
  assert.equal(env.PATH, 'path'); assert.equal(env.CODEX_HOME, 'auth-home');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_PERMISSION_PROFILE', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
});

test('diagnostics redact tokens and email addresses', () => {
  const value = safeDiagnostic('Account person@example.com key sk-testcredential123456 Bearer abcd.efgh token api_key=verysecret');
  assert.ok(!value.includes('person@example.com')); assert.ok(!value.includes('sk-testcredential')); assert.ok(!value.includes('abcd.efgh')); assert.ok(!value.includes('verysecret'));
});

test('Claude five-hour and weekly limit messages become clear rate-limit errors',()=>{
  for(const text of ["You've hit your 5-hour limit · resets 3:40pm (America/Sao_Paulo)","You've hit your weekly limit"]) {
    const error=classifyFailure(text,'claude');
    assert.equal(error.code,'RATE_LIMIT');assert.match(error.message,/limite de uso atingido/);
  }
});

test('official flags keep meeting agents restricted and never use API-only bare mode', () => {
  const codex = buildArguments('codex', '/tmp/meeting');
  assert.ok(codex.includes('read-only')); assert.ok(codex.includes('shell_tool')); assert.ok(codex.includes('forced_login_method="chatgpt"'));
  assert.ok(!codex.some(flag => flag.includes('bypass')));
  const claude = buildArguments('claude', '/tmp/meeting');
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--safe-mode')); assert.ok(claude.includes('--restricted')); assert.ok(!claude.includes('--bare'));
});

test('Codex parser ignores reasoning, deduplicates final messages and retains usage', () => {
  const chunks = [], parser = createEventCollector('codex', { onDelta: text => chunks.push(text) });
  for (const event of [{ type: 'thread.started', thread_id: 'session' }, { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'private reasoning' } }, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Resposta' } }, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Resposta' } }, { type: 'turn.completed', usage: { input_tokens: 12 } }]) parser.accept(JSON.stringify(event));
  assert.equal(parser.result().text, 'Resposta'); assert.equal(parser.result().sessionId, 'session'); assert.equal(parser.result().usage.input_tokens, 12); assert.deepEqual(chunks, ['Resposta']);
});

test('Claude parser uses result once, streams only public text, preserves failure', () => {
  const chunks = [], parser = createEventCollector('claude', { onDelta: text => chunks.push(text) });
  for (const event of [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } } }, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá' } } }, { type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Olá' }] } }, { type: 'result', subtype: 'success', result: 'Olá', session_id: 'session' }]) parser.accept(JSON.stringify(event));
  assert.equal(parser.result().text, 'Olá'); assert.deepEqual(chunks, ['Olá']);
  parser.accept(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached'] }));
  assert.equal(classifyFailure(parser.result().error, 'claude').code, 'RATE_LIMIT');
});

test('empty and malformed events do not invent responses', () => {
  const parser = createEventCollector('codex'); parser.accept('not JSON'); parser.accept('');
  assert.equal(parser.result().text, ''); assert.equal(parser.result().sawEvents, false);
  parser.accept(JSON.stringify({ type: 'turn.failed', error: { message: 'connection failed' } }));
  assert.equal(parser.result().error, 'connection failed');
});

test('invalid agent and workspace fail before spawning', async () => {
  await assert.rejects(runAgent({ agent: 'unknown', prompt: 'x', cwd: '/tmp' }), { code: 'INVALID_AGENT' });
  await assert.rejects(runAgent({ agent: 'codex', prompt: 'x', cwd: 'relative' }), { code: 'INVALID_WORKSPACE' });
});

test('cancellation terminates the owned child process', async () => {
  const abort = new AbortController();
  const pending = runLocalProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: abort.signal });
  setTimeout(() => abort.abort(), 75);
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('subprocess deadline stops a child that produces no response', async () => {
  await assert.rejects(runLocalProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 75 }), { code: 'TIMEOUT' });
});

test('bounded subprocess output prevents unbounded buffering', async () => {
  await assert.rejects(runLocalProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000));setTimeout(() => {}, 60000)'], { limit: 100 }), { code: 'OUTPUT_LIMIT' });
});

test('UTF-8 text and final JSONL without newline survive the process bridge', async () => {
  const lines = [];
  const result = await runLocalProcess(process.execPath, ['-e', 'process.stdin.setEncoding("utf8");process.stdin.on("data", text => process.stdout.write(JSON.stringify({text})))'], { input: 'Conexão ✓', onLine: line => lines.push(JSON.parse(line)) });
  assert.equal(result.code, 0); assert.deepEqual(lines, [{ text: 'Conexão ✓' }]);
});
