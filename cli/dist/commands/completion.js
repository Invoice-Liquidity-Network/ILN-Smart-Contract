"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeCompletionCommand = makeCompletionCommand;
const commander_1 = require("commander");
const COMMANDS = {
    config: [],
    export: [],
    wallet: ["generate", "import", "show", "fund", "list"],
    reputation: [],
};
const GLOBAL_FLAGS = ["--profile", "--json"];
function makeCompletionCommand() {
    const cmd = new commander_1.Command("completion").description("Generate shell completion scripts");
    cmd
        .command("bash")
        .description("Generate bash completion script")
        .action(() => {
        const script = `
_iln_completion() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="${Object.keys(COMMANDS).join(" ")}"
  local flags="${GLOBAL_FLAGS.join(" ")}"

  if [[ "\$prev" == "wallet" ]]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.wallet.join(" ")}" -- "\$cur") )
  else
    COMPREPLY=( $(compgen -W "\$commands \$flags" -- "\$cur") )
  fi
}
complete -F _iln_completion iln
`;
        console.log(script);
        console.log(`\n# Installation:\n# source <(iln completion bash)`);
    });
    cmd
        .command("zsh")
        .description("Generate zsh completion script")
        .action(() => {
        const script = `
_iln() {
  local -a commands=("${Object.keys(COMMANDS).join('" "')}")
  local -a flags=("${GLOBAL_FLAGS.join('" "')}")
  local -a wallet_cmds=("${COMMANDS.wallet.join('" "')}")

  if [[ "\${words[CURRENT-1]}" == "wallet" ]]; then
    _describe 'wallet commands' wallet_cmds
  else
    _describe 'iln commands' commands
  fi
}
compdef _iln iln
`;
        console.log(script);
        console.log(`\n# Installation:\n# echo 'source <(iln completion zsh)' >> ~/.zshrc`);
    });
    cmd
        .command("fish")
        .description("Generate fish completion script")
        .action(() => {
        const script = `
complete -c iln
${Object.keys(COMMANDS).map(cmd => `complete -c iln -n "__fish_use_subcommand" -a "${cmd}"`).join("\n")}
${GLOBAL_FLAGS.map(flag => `complete -c iln -a "${flag}"`).join("\n")}
${COMMANDS.wallet.map(cmd => `complete -c iln -n "__fish_use_subcommand" -a "${cmd}"`).join("\n")}
`;
        console.log(script);
        console.log(`\n# Installation:\n# iln completion fish > ~/.config/fish/completions/iln.fish`);
    });
    return cmd;
}
//# sourceMappingURL=completion.js.map