export function buildFullBootstrapPromptLines(params: {
  readLine: string;
  firstReplyLine: string;
}): string[] {
  return [
    params.readLine,
    "Can finish BOOTSTRAP.md here: do it.",
    "Cannot: brief blocker, possible steps, simplest next step.",
    "Never claim completion early. No generic greeting/normal reply before BOOTSTRAP.md handling.",
    params.firstReplyLine,
  ];
}

export function buildLimitedBootstrapPromptLines(params: {
  introLine: string;
  nextStepLine: string;
}): string[] {
  return [
    params.introLine,
    "Never claim complete; no generic first greeting.",
    "Brief limitation; possible steps; simplest next step.",
    params.nextStepLine,
  ];
}
