import fs from 'node:fs'
import path from 'node:path'

// Shell integration: each script makes its shell emit OSC 133 A (prompt start), B (input start), C (output start),
// D;<exit> (command finished) and OSC 7 (cwd). Scripts are string constants because package.json ships only dist/.

const S = '$' // keeps `${` out of the template literals below

const BASH = String.raw`[ -f ~/.bashrc ] && . ~/.bashrc
__pager_precmd() {
  local s=$?
  [ -n "$__pager_seen" ] && printf '\e]133;D;%s\a' "$s"
  __pager_seen=1
  printf '\e]7;file://%s%s\a\e]133;A\a' "${S}{HOSTNAME-}" "$PWD"
}
PROMPT_COMMAND="__pager_precmd${S}{PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1="${S}{PS1}"'\[\e]133;B\a\]'
PS0=$'\e]133;C\a'
`

const ZSHENV = String.raw`[ -f "${S}{PAGER_ZDOTDIR:-$HOME}/.zshenv" ] && . "${S}{PAGER_ZDOTDIR:-$HOME}/.zshenv"
`

const ZSHRC = String.raw`ZDOTDIR="${S}{PAGER_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
__pager_precmd() {
  local s=$?
  [ -n "$__pager_seen" ] && printf '\e]133;D;%s\a' "$s"
  __pager_seen=1
  printf '\e]7;file://%s%s\a\e]133;A\a' "$HOST" "$PWD"
}
__pager_preexec() { printf '\e]133;C\a' }
precmd_functions=(__pager_precmd $precmd_functions)
preexec_functions+=(__pager_preexec)
PS1=$PS1$'%{\e]133;B\a%}'
`

const FISH = String.raw`function __pager_preexec --on-event fish_preexec
  printf '\e]133;C\a'
end
function __pager_postexec --on-event fish_postexec
  set -l s $status
  printf '\e]133;D;%s\a' $s
end
function __pager_ret
  return $argv[1]
end
functions -c fish_prompt __pager_prompt
function fish_prompt
  set -l s $status
  printf '\e]7;file://%s%s\a\e]133;A\a' (hostname) $PWD
  __pager_ret $s
  __pager_prompt
  printf '\e]133;B\a'
end
`

const PWSH = String.raw`if (-not (Test-Path variable:global:__pagerPrompt)) {
  $global:__pagerPrompt = $function:prompt
  $global:__pagerSeen = $false
  function global:prompt {
    $ok = $?
    $code = $global:LASTEXITCODE
    $e = [char]27
    $b = [char]7
    $out = ''
    if ($global:__pagerSeen) {
      $n = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }
      $out += "$e]133;D;$n$b"
    }
    $global:__pagerSeen = $true
    if ($PWD.Provider.Name -eq 'FileSystem') {
      $out += "$e]7;file://localhost/" + ($PWD.ProviderPath -replace '\\', '/') + $b
    }
    $out += "$e]133;A$b"
    $out += (& $global:__pagerPrompt)
    $out += "$e]133;B$b"
    $global:LASTEXITCODE = $code
    $out
  }
  if (Get-Module PSReadLine) {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
      [Console]::Write("$([char]27)]133;C$([char]7)")
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  }
}
`

export const SHELL_FILES: Readonly<Record<string, string>> = {
  'bash.sh': BASH,
  'zsh/.zshenv': ZSHENV,
  'zsh/.zshrc': ZSHRC,
  'fish.fish': FISH,
  'pwsh.ps1': PWSH,
}

/** Writes the integration scripts under dir, touching only files whose content differs. */
export function writeShellFiles(dir: string): void {
  for (const [name, content] of Object.entries(SHELL_FILES)) {
    const file = path.join(dir, name)
    let same = false
    try {
      same = fs.readFileSync(file, 'utf8') === content
    } catch {
      /* missing: write it */
    }
    if (same) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}
