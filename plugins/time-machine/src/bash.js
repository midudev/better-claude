// Which Bash commands only look. A turn of `ls`, `grep` and `git status` takes no snapshot:
// every segment of the command has to be one of these, and nothing in it may write. When
// unsure, a command can write, and its turn gets its snapshot.

const GIT = 'git(?:\\s+-C\\s+\\S+)?\\s+'
const LOOKS = new RegExp(`^(?:cd|ls|ll|pwd|cat|head|tail|less|wc|grep|egrep|rg|ag|find|fd|tree|file|stat|du|df|which|type|echo|printf|date|whoami|uname|diff|cmp|jq|${GIT}(?:status|log|diff|show|blame|grep|ls-files|ls-tree|rev-parse|rev-list|describe|shortlog|reflog|for-each-ref|show-ref|cat-file|merge-base|name-rev|check-ignore|count-objects))(?:\\s|$)`)
// Commands whose arguments can make them write or run something: only these exact forms look
const LOOKS_EXACTLY = new RegExp(`^(?:env|${GIT}(?:branch(?:\\s+(?:-a|-r|-v|-vv|--list|--show-current))*|remote(?:\\s+-v)?|stash\\s+list|config\\s+--get\\S*\\s+\\S+))\\s*$`)
// Whatever writes or runs something else, wherever it is in the command: a redirection, a
// substitution (`$(…)`, backticks, `<(…)`), tee and xargs, and the options that write a file or
// run a command (find -delete/-exec/-fls, fd -x/--exec, git diff --output, tree -o, rg --pre).
// Some of them are harmless elsewhere (grep -o): those just get a snapshot they did not need
const WRITES = /[>`]|[$<]\(|\b(?:tee|xargs)\b|\s-(?:delete|exec|execdir|ok|fls|fprint\S*|[xXo])(?:\s|$)|\s--(?:exec(?:-batch)?|output|pre)\b/
// Redirections that write nothing: an error stream into the output, or anything into /dev/null
const HARMLESS = /\s*(?:\d?>&\d|\d?>\s*\/dev\/null)/g

/** @param {string} command */
export function readOnly (command) {
  const plain = command.replace(HARMLESS, '')
  if (WRITES.test(plain)) return false
  // A lone `&` runs two commands as much as `;` does
  const segments = plain.split(/\|\||&&|[|;&\n]/).map(part => part.trim()).filter(Boolean)
  return segments.length > 0 && segments.every(part => LOOKS.test(part) || LOOKS_EXACTLY.test(part))
}
