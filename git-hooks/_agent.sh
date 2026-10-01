# Sourced by the hooks. Tells which agent runs git by walking the Windows process
# ancestry: Antigravity / its language server -> gemini, claude.exe -> claude, else human.
# Git has no idea who commits (every agent commits as the owner), the process tree does.
# GIT_HOOK_AGENT=gemini forces the strict mode for testing; it can never relax it.

detect_agent() {
    [ "$GIT_HOOK_AGENT" = "gemini" ] && { echo gemini; return; }
    wp=$(cat /proc/$$/winpid 2>/dev/null)
    [ -z "$wp" ] && { echo human; return; }
    powershell.exe -NoProfile -NonInteractive -Command "
        \$m=@{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name |
            ForEach-Object { \$m[[int]\$_.ProcessId]=\$_ };
        \$p=$wp;
        for(\$i=0; \$i -lt 40 -and \$m.ContainsKey(\$p); \$i++){
            \$n=\$m[\$p].Name;
            if(\$n -match '^(Antigravity|language_server)'){ 'gemini'; exit }
            if(\$n -match '^claude'){ 'claude'; exit }
            \$q=[int]\$m[\$p].ParentProcessId; if(\$q -eq \$p){ break }; \$p=\$q
        }; 'human'" 2>/dev/null | tr -d '\r'
}

# Command line of the nearest git.exe above this hook: some options (--amend with -m)
# leave no other trace a hook can see.
git_cmdline() {
    wp=$(cat /proc/$$/winpid 2>/dev/null)
    [ -z "$wp" ] && return 0
    powershell.exe -NoProfile -NonInteractive -Command "
        \$m=@{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine |
            ForEach-Object { \$m[[int]\$_.ProcessId]=\$_ };
        \$p=$wp;
        for(\$i=0; \$i -lt 10 -and \$m.ContainsKey(\$p); \$i++){
            if(\$m[\$p].Name -ieq 'git.exe' -and \$m[\$p].CommandLine -match '\scommit(\s|$)'){ \$m[\$p].CommandLine; exit }
            \$q=[int]\$m[\$p].ParentProcessId; if(\$q -eq \$p){ break }; \$p=\$q
        }" 2>/dev/null | tr -d '\r'
}

# Run the repository's own hook of the same name, if it has one: a global hooksPath
# hides .git/hooks, and a repo-specific check must not silently stop running.
run_local_hook() {
    name="$1"; shift
    gd=$(git rev-parse --git-dir 2>/dev/null) || return 0
    local_hook="$gd/hooks/$name"
    [ -x "$local_hook" ] || return 0
    cmp -s "$local_hook" "$(dirname "$0")/$name" && return 0
    "$local_hook" "$@"
}
