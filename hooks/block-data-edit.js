#!/usr/bin/env node
// PreToolUse hook: data/ 아래 원본 파일 수정을 차단한다.
//  - Write / Edit / NotebookEdit : 대상 경로가 data/ 안이면 차단
//  - Bash / PowerShell           : data/ 또는 원본 파일명을 가리키는 쓰기성 명령이면 차단 (명령문 텍스트 기반, 최선의 노력)
// 읽기(ls, cat, openpyxl.load_workbook 등)와 summary.xlsx 같은 다른 파일 저장은 통과시킨다.
const path = require('path');

const ORIGINALS = ['조립팀_자주검사기록', '품질팀_도장검사기록', '품질팀_선각검사기록'];

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `data/ 아래 원본 파일은 수정하지 않습니다 (CLAUDE.md). ${reason} 결과는 summary.xlsx에만 반영하세요.`,
      },
    })
  );
  process.exit(0);
}

// 텍스트가 data/ 폴더나 원본 파일명을 가리키는지
function refsData(s) {
  if (/(^|[^A-Za-z0-9_])data[\\/]/i.test(s)) return true; // data/, .\data\, ..\data\
  if (/['"]data['"]/i.test(s)) return true; // os.path.join('data', ...)
  return ORIGINALS.some((n) => s.includes(n));
}

function checkFileTool(input) {
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.notebook_path;
  if (!target) return;
  const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const dataDir = path.join(projectDir, 'data');
  const abs = path.resolve(input.cwd || projectDir, target);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(dataDir), norm(abs));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    deny(`(${path.basename(abs)} 편집 차단)`);
  }
}

// 셸 쓰기 동사 (PowerShell cmdlet·별칭, cmd, POSIX)
const SHELL_WRITE =
  /(^|[\s;|&(])(copy-item|cpi|copy|cp|move-item|mi|move|mv|remove-item|ri|rm|rmdir|rd|del|erase|set-content|sc|add-content|ac|clear-content|out-file|tee-object|tee|new-item|ni|rename-item|rni|ren|rename|set-itemproperty|sed\s+-i|truncate|touch|attrib|icacls|chmod|xcopy|robocopy|expand-archive|unzip)(?=\s|$)/i;

// git 으로 작업트리를 되돌리거나 바꾸는 명령
const GIT_MUTATE =
  /\bgit\s+(?:-\S+\s+)*(restore|checkout|reset|clean|stash|apply|am|rm|mv|merge|rebase|pull|cherry-pick|revert|switch)\b/i;
const GIT_BROAD =
  /\bgit\s+(?:-\S+\s+)*(?:reset\s+--hard|clean\b|stash\b|checkout\s+(?:-f\b|--\s*\.|\.)|restore\s+(?:\.|:\/|\*)|switch\s+-f\b)/i;

function checkCommand(cmd) {
  // 1) 파이썬/스크립트 안의 저장 호출: save / saveas / to_excel / to_csv
  const saveRe = /\.(save|saveas|to_excel|to_csv)\(\s*(?:[fFrR]?(['"])(.*?)\2|([^,)]*))/gi;
  let m;
  while ((m = saveRe.exec(cmd))) {
    const literal = m[3];
    if (literal !== undefined) {
      if (refsData(literal)) return `${m[1]}(${literal}) 가 원본을 덮어씁니다.`;
    } else if (refsData(cmd)) {
      // 인자가 변수라 대상을 알 수 없음 + 명령이 data/를 다룸
      return `${m[1]}(${(m[4] || '').trim()}) 의 저장 대상을 알 수 없고 명령이 data/ 를 다룹니다. 저장 경로를 문자열로 명시하세요(예: 'summary.xlsx').`;
    }
  }

  // 2) 그 밖의 파이썬 파일 쓰기/삭제 (대상 추적이 어려워 data/ 참조가 있으면 차단)
  const PY_WRITE = [
    /\bshutil\.\w+\(/,
    /\bos\.(remove|rename|replace|unlink|rmdir|removedirs)\(/,
    /\.(unlink|rename|write_text|write_bytes|touch|rmdir)\(/,
    /\bopen\(\s*[^,)]+,\s*['"][^'"]*[wax+]/,
    /SaveChanges/i,
  ];
  if (refsData(cmd) && PY_WRITE.some((re) => re.test(cmd))) {
    return '파이썬 파일 쓰기/삭제 호출이 data/ 를 다룹니다.';
  }

  // 3) git 되돌리기
  if (GIT_BROAD.test(cmd)) return 'git 으로 작업트리 전체를 되돌리는 명령입니다.';
  if (GIT_MUTATE.test(cmd) && refsData(cmd)) return 'git 명령이 data/ 를 바꿉니다.';

  // 4) 셸 문장 단위: 쓰기 동사 + data 참조, 리다이렉트 대상이 data
  for (const seg of cmd.split(/[;&|\n]+/)) {
    if (SHELL_WRITE.test(seg) && refsData(seg)) return `쓰기성 셸 명령: ${seg.trim().slice(0, 80)}`;
    const re = />{1,2}\s*['"]?([^\s'"|;&]+)/g;
    let r;
    while ((r = re.exec(seg))) if (refsData(r[1])) return `리다이렉트(> ${r[1]}) 대상이 원본입니다.`;
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const tool = input.tool_name || '';
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = (input.tool_input || {}).command;
    if (typeof cmd === 'string') {
      const why = checkCommand(cmd);
      if (why) deny(why);
    }
  } else {
    checkFileTool(input);
  }
  process.exit(0);
});
