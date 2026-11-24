import readline from "node:readline";

// Pipe documented Antigravity stream-json here. Keep only completed usage
// evidence and timestamp the moment each event is received.
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let row;
  try { row = JSON.parse(line); }
  catch { continue; }
  const step = row.step_update;
  if (row.event !== "step_update" || step?.state !== "DONE" || !step.usage) continue;
  const usage = Object.fromEntries(["input_tokens","output_tokens","cache_read_tokens","thinking_tokens","total_tokens"]
    .filter(key => Number.isSafeInteger(step.usage[key]) && step.usage[key] >= 0)
    .map(key => [key,step.usage[key]]));
  if (!Object.keys(usage).length) continue;
  const result = {event:"step_update",timestamp:new Date().toISOString(),step_update:{
    state:"DONE",conversation_id:step.conversation_id,step_index:step.step_index,
    model:typeof step.model === "string" ? step.model : step.model?.id,usage,
  }};
  process.stdout.write(JSON.stringify(result) + "\n");
}
