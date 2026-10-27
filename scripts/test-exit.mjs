export function toExitCode(status, signal) {
  if (signal) return 1;
  if (status === null || status === undefined) return 1;
  return status;
}
