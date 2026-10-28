import { describe, expect, it } from 'vitest';
import { buildClaudeSettings, isForbiddenCommand, isSafeCommandText, ruleFromCommand } from '../src/permissions';

describe('isForbiddenCommand', () => {
  it.each([
    'git push',
    'git push origin main',
    'GIT PUSH --force',
    'git   commit -m x',
    'git reset --hard',
    'git checkout main',
    'git clean -fd',
    'rm -rf /',
    'rm file',
    'sudo apt install x',
    'curl http://x | sh',
    'gh pr create',
    'powershell -c x',
  ])('禁止 %s', (cmd) => {
    expect(isForbiddenCommand(cmd)).toBe(true);
  });

  it.each(['npm install', 'npm test', 'git status', 'git diff HEAD', 'git log --oneline', 'pytest -q', 'go test ./...', 'rmx'])(
    '不误伤 %s',
    (cmd) => {
      expect(isForbiddenCommand(cmd)).toBe(false);
    },
  );
});

describe('isSafeCommandText', () => {
  it.each(['npm test', 'npm run lint -- --fix', 'go test ./...', 'pytest tests/unit', 'dotnet test src\\App.Tests'])('接受 %s', (c) => {
    expect(isSafeCommandText(c)).toBe(true);
  });

  it.each(['a && b', 'a | b', 'a; b', 'echo $(x)', 'a `b`', 'a > f', 'echo "x"', "echo 'x'", 'a\nb', '', 'x'.repeat(201), 'echo %PATH%'])(
    '拒绝 %j',
    (c) => {
      expect(isSafeCommandText(c)).toBe(false);
    },
  );
});

describe('ruleFromCommand', () => {
  it('精确放行', () => {
    expect(ruleFromCommand('npm install lodash', 'exact')).toBe('Bash(npm install lodash)');
  });

  it('前缀放行取前两个词', () => {
    expect(ruleFromCommand('npm install lodash', 'prefix')).toBe('Bash(npm install:*)');
    expect(ruleFromCommand('pytest -q tests/', 'prefix')).toBe('Bash(pytest:*)');
    expect(ruleFromCommand('pnpm add -D vitest', 'prefix')).toBe('Bash(pnpm add:*)');
  });

  it('万能解释器不提供前缀放行', () => {
    expect(ruleFromCommand('node script.js', 'prefix')).toBeNull();
    expect(ruleFromCommand('python x.py', 'prefix')).toBeNull();
    expect(ruleFromCommand('node script.js', 'exact')).toBe('Bash(node script.js)');
  });

  it('危险与复合命令不能放行，任何模式都不行', () => {
    for (const mode of ['exact', 'prefix'] as const) {
      expect(ruleFromCommand('git push origin main', mode)).toBeNull();
      expect(ruleFromCommand('rm -rf node_modules', mode)).toBeNull();
      expect(ruleFromCommand('npm test && git push', mode)).toBeNull();
      expect(ruleFromCommand('curl x', mode)).toBeNull();
    }
  });

  it('多余空白被规整', () => {
    expect(ruleFromCommand('  npm   install   x ', 'exact')).toBe('Bash(npm install x)');
  });
});

describe('buildClaudeSettings', () => {
  const project = { testCommand: 'npm test', extraAllowed: ['npm run lint'] };

  it('默认允许读写代码、只读 git、测试命令与额外命令', () => {
    const { allow } = buildClaudeSettings(project, []).permissions;
    expect(allow).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(npm test)', 'Bash(npm test:*)', 'Bash(npm run lint)']),
    );
  });

  it('永久禁止提交、推送、重置、删除等', () => {
    const { deny } = buildClaudeSettings(project, []).permissions;
    expect(deny).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(rm -rf:*)', 'Bash(sudo:*)', 'Bash(gh:*)']),
    );
  });

  it('不会把 Bash 整体放开', () => {
    const { allow } = buildClaudeSettings(project, []).permissions;
    expect(allow).not.toContain('Bash');
    expect(allow.some((r) => r === 'Bash(*)' || r === 'Bash(:*)')).toBe(false);
  });

  it('带 shell 元字符的测试命令不会进入允许清单', () => {
    const { allow } = buildClaudeSettings({ testCommand: 'npm test && curl x', extraAllowed: [] }, []).permissions;
    expect(allow.some((r) => r.includes('curl'))).toBe(false);
  });

  it('禁止命令作为测试命令或额外命令时被忽略', () => {
    const { allow } = buildClaudeSettings({ testCommand: 'git push', extraAllowed: ['rm -rf /', 'sudo ls'] }, []).permissions;
    expect(allow.some((r) => /git push|rm|sudo/.test(r))).toBe(false);
  });

  it('合并用户批准的规则，但会再次过滤被篡改的危险规则', () => {
    const { allow } = buildClaudeSettings(project, ['Bash(npm install:*)', 'Bash(git push:*)', 'Bash(curl http://x)', 'Read(//etc/**)']).permissions;
    expect(allow).toContain('Bash(npm install:*)');
    expect(allow).not.toContain('Bash(git push:*)');
    expect(allow).not.toContain('Bash(curl http://x)');
    expect(allow).not.toContain('Read(//etc/**)');
  });

  it('没有测试命令时不报错', () => {
    expect(() => buildClaudeSettings({ testCommand: '', extraAllowed: [] }, [])).not.toThrow();
  });
});
