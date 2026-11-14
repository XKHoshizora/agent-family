// Capability-specific: M3.1 Flash does not support disabling thinking.
export function supportsMiniMaxFinalization(model: string) {
  return /^MiniMax-M3$/i.test(model);
}

export function turnCallAllowance(model: string, tools: boolean) {
  return (tools ? 3 : 1) + (supportsMiniMaxFinalization(model) ? 1 : 0);
}
