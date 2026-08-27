import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { traceToolCall } from '../dist/tool-trace.js';

const root = path.resolve('data', `tool-trace-smoke-${process.pid}-${Date.now()}`);
const traceFile = path.join(root, 'traces.ndjson');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
process.env.MCP_TRACE_MODE = 'detailed';
process.env.MCP_TRACE_FILE = traceFile;

try {
  await traceToolCall({
    serviceId: 'smoke',
    workspace: 'workspace-a',
    tool: 'sensitive_tool',
    arguments: {
      path: 'src/index.ts',
      token: 'top-secret-token',
      content: 'source-body-must-not-be-persisted',
      rawUserInput: 'raw-user-history-must-not-be-persisted',
      args: ['--mode', 'test', '--api-key', 'command-secret', '--token=inline-secret'],
      nested: { authorization: 'Bearer hidden', password: 'hidden-password', note: 'visible' },
    },
    invoke: async () => ({ ok: true, payload: 'result-body-must-not-be-persisted' }),
  });
  try {
    await traceToolCall({
      serviceId: 'smoke',
      workspace: 'workspace-a',
      tool: 'failing_tool',
      arguments: { path: 'src/index.ts' },
      invoke: async () => { throw new Error('authorization=Bearer-error-secret token=error-token --password error-password'); },
    });
  } catch {}
  await traceToolCall({
    serviceId: 'smoke',
    workspace: 'workspace-a',
    tool: 'workspace_context',
    arguments: { detail: 'summary' },
    invoke: async () => ({ ok: true }),
  });
  let lines = [];
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && lines.length < 3) {
    lines = await readFile(traceFile, 'utf8').then((value) => value.split(/\r?\n/).filter(Boolean)).catch(() => []);
    if (lines.length < 3) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (lines.length < 3) throw new Error('Trace write queue did not flush in time');
  const line = lines.find((value) => JSON.parse(value).tool === 'sensitive_tool');
  const errorLine = lines.find((value) => JSON.parse(value).tool === 'failing_tool');
  if (!line || !errorLine) throw new Error(`Expected trace records missing: ${lines.join('\n')}`);
  const record = JSON.parse(line);
  const errorRecord = JSON.parse(errorLine);
  if (record.arguments.token !== '[REDACTED]' || record.arguments.nested.authorization !== '[REDACTED]' || record.arguments.nested.password !== '[REDACTED]') {
    throw new Error(`Sensitive Tool Trace arguments were not redacted: ${line}`);
  }
  if (record.arguments.path !== 'src/index.ts' || record.arguments.nested.note !== 'visible') throw new Error(`Non-sensitive Tool Trace arguments were unexpectedly removed: ${line}`);
  if (!String(record.arguments.content).startsWith('[TEXT ') || !String(record.arguments.content).includes('sha256:')) throw new Error(`Content argument was not summarized safely: ${line}`);
  if (!String(record.arguments.rawUserInput).startsWith('[TEXT ') || !String(record.arguments.rawUserInput).includes('sha256:')) throw new Error(`Raw user history was not summarized safely: ${line}`);
  if (record.arguments.args?.[3] !== '[REDACTED]' || record.arguments.args?.[4] !== '--token=[REDACTED]') throw new Error(`Sensitive command args were not redacted: ${line}`);
  if (line.includes('top-secret-token') || line.includes('hidden-password') || line.includes('Bearer hidden') || line.includes('source-body-must-not-be-persisted') || line.includes('raw-user-history-must-not-be-persisted') || line.includes('command-secret') || line.includes('inline-secret')) throw new Error('Trace file contains plaintext secret/content material');
  if (line.includes('result-body-must-not-be-persisted')) throw new Error('Trace file persisted the Tool result body');
  if (record.status !== 'ok' || !(record.resultBytes > 0) || typeof record.durationMs !== 'number') throw new Error(`Trace metrics missing: ${line}`);
  if (errorRecord.status !== 'error' || !String(errorRecord.error).startsWith('[Error ') || !String(errorRecord.error).includes('sha256:')) throw new Error(`Trace error message was not summarized safely: ${errorLine}`);
  if (errorLine.includes('Bearer-error-secret') || errorLine.includes('error-token') || errorLine.includes('error-password')) throw new Error(`Trace error persisted plaintext secret material: ${errorLine}`);
  const stats = JSON.parse(await readFile(`${traceFile}.stats.json`, 'utf8'));
  if (stats?.tools?.sensitive_tool?.total !== 1 || stats?.tools?.sensitive_tool?.failures !== 0 || stats?.tools?.failing_tool?.total !== 1 || stats?.tools?.failing_tool?.failures !== 1) {
    throw new Error(`Tool Trace aggregate totals are invalid: ${JSON.stringify(stats)}`);
  }
  if (!Array.isArray(stats.tools.sensitive_tool.recentDurationsMs) || stats.tools.sensitive_tool.recentDurationsMs.length !== 1 || typeof stats.tools.sensitive_tool.fastestMs !== 'number' || typeof stats.tools.sensitive_tool.slowestMs !== 'number') {
    throw new Error(`Tool Trace aggregate latency metrics are invalid: ${JSON.stringify(stats)}`);
  }
  if (stats?.variants?.['workspace_context::summary']?.total !== 1 || stats?.variants?.['workspace_context::summary']?.failures !== 0) {
    throw new Error(`Tool Trace operation aggregate is invalid: ${JSON.stringify(stats)}`);
  }
  const taskGetRecord = lines.map((value) => JSON.parse(value)).find((value) => value.tool === 'workspace_context');
  if (taskGetRecord?.operation !== 'summary') throw new Error(`Tool Trace operation label missing: ${JSON.stringify(taskGetRecord)}`);
  console.log(JSON.stringify({ ok: true, checks: ['tool_trace_sensitive_argument_redaction', 'tool_trace_content_hash_summary', 'tool_trace_raw_history_hash_summary', 'tool_trace_command_flag_redaction', 'tool_trace_error_hash_summary', 'tool_trace_result_body_not_persisted', 'tool_trace_duration_and_result_bytes', 'tool_trace_persistent_aggregate_stats', 'tool_trace_operation_aggregate'] }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
