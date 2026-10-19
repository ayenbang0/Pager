/** One agent CLI pager knows how to launch. `id` is also the `cli` value stored on agent instances. */
export interface AgentPreset {
  id: string
  label: string
  /** Executable looked up on PATH. */
  bin: string
  /** A separate executable that speaks ACP when the main one does not (claude -> claude-agent-acp). */
  acpBin?: string
  /** Arguments that make `acpBin ?? bin` speak ACP over stdio. Absent when the CLI has no ACP mode. */
  acp?: string[]
  /** The CLI can run a single prompt non-interactively. */
  oneShot?: boolean
  /** How to install it, shown in the setup screen. */
  install?: string
  /** What to do when the readiness check fails on authentication. */
  auth?: string
  /** One-shot flags placed before the prompt; the value is appended. */
  modelFlag?: string[]
  effortFlag?: string[]
  /** Effort levels to offer when the agent does not advertise its own. */
  efforts?: string[]
}

const REGISTRY = 'see https://agentclientprotocol.com/get-started/registry'

export const PRESETS: Record<string, AgentPreset> = {
  omp: {
    id: 'omp',
    label: 'Oh My Pi',
    bin: 'omp',
    acp: ['acp'],
    oneShot: true,
    install: REGISTRY,
    modelFlag: ['--model'],
    effortFlag: ['--thinking'],
    efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'],
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    acpBin: 'claude-agent-acp',
    acp: [],
    oneShot: true,
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    auth: 'run claude auth login',
    modelFlag: ['--model'],
    effortFlag: ['--effort'],
    efforts: ['low', 'medium', 'high'],
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    acp: ['acp'],
    oneShot: true,
    install: REGISTRY,
    modelFlag: ['-m'],
    effortFlag: ['--variant'],
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    bin: 'hermes',
    acp: ['acp'],
    oneShot: true,
    install: REGISTRY,
    modelFlag: ['-m'],
    effortFlag: ['--reasoning'],
    efforts: ['none', 'minimal', 'low', 'medium', 'high'],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    acp: ['--acp'],
    install: 'npm install -g @google/gemini-cli',
    auth: 'run gemini and sign in',
  },
  codex: { id: 'codex', label: 'Codex', bin: 'codex-acp', acp: [], install: 'npm install -g @agentclientprotocol/codex-acp' },
  goose: { id: 'goose', label: 'Goose', bin: 'goose', acp: ['acp'], install: REGISTRY },
  kimi: { id: 'kimi', label: 'Kimi CLI', bin: 'kimi', acp: ['acp'], install: REGISTRY },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    acp: ['--acp', '--stdio'],
    install: 'npm install -g @github/copilot',
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    acp: ['--acp', '--experimental-skills'],
    install: 'npm install -g @qwen-code/qwen-code',
  },
  cursor: { id: 'cursor', label: 'Cursor Agent', bin: 'cursor-agent', acp: ['acp'], install: REGISTRY },
  cline: { id: 'cline', label: 'Cline', bin: 'cline', acp: ['--acp'], install: 'npm install -g cline' },
  devin: { id: 'devin', label: 'Devin', bin: 'devin', acp: ['acp'], install: REGISTRY },
  kilo: { id: 'kilo', label: 'Kilo Code', bin: 'kilo', acp: ['acp'], install: REGISTRY },
  junie: { id: 'junie', label: 'Junie', bin: 'junie', acp: ['--acp=true'], install: REGISTRY },
  auggie: { id: 'auggie', label: 'Auggie', bin: 'auggie', acp: ['--acp'], install: REGISTRY },
  grok: { id: 'grok', label: 'Grok', bin: 'grok', acp: ['agent', 'stdio'], install: REGISTRY },
  vibe: { id: 'vibe', label: 'Mistral Vibe', bin: 'vibe-acp', acp: [], install: REGISTRY },
  pi: { id: 'pi', label: 'Pi', bin: 'pi-acp', acp: [], install: REGISTRY },
  qoder: { id: 'qoder', label: 'Qoder CLI', bin: 'qodercli', acp: ['--acp'], install: REGISTRY },
  kiro: { id: 'kiro', label: 'Kiro CLI', bin: 'kiro-cli-chat', acp: ['acp'], install: REGISTRY },
  iflow: { id: 'iflow', label: 'iFlow CLI', bin: 'iflow', acp: ['--experimental-acp'], install: REGISTRY },
}

/** The command that makes this preset speak ACP over stdio, or undefined when it has no ACP mode. */
export function launch(preset: AgentPreset): { bin: string; args: string[] } | undefined {
  if (preset.acp === undefined && preset.acpBin === undefined) return undefined
  return { bin: preset.acpBin ?? preset.bin, args: preset.acp ?? [] }
}
