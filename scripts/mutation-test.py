#!/usr/bin/env python3
"""
Stryker Caseiro — Mutation Testing simplificado.

Como funciona:
1. Lê cada arquivo .ts em src/ (excluindo __tests__)
2. Encontra pontos de mutação (===, !==, >, <, return true/false, &&, ||, etc)
3. Para cada mutação:
   a. Aplica a mutação no arquivo
   b. Roda: npx vitest run src/__tests__/<basename>*.test.ts --reporter=dot
   c. Se testes FALHARAM → mutação morta ✅ (testes pegam)
   d. Se testes PASSARAM → mutação sobreviveu ❌ (gap de teste!)
   e. git checkout -- <arquivo> (reverte)
4. Gera relatório com mutações sobreviventes

Uso:
  python3 scripts/mutation-test.py                    # roda em todos os arquivos
  python3 scripts/mutation-test.py src/pokaYoke.ts    # roda em um arquivo específico
  python3 scripts/mutation-test.py --quick            # só 5 mutações por arquivo

Segurança:
- Cada mutação é revertida com git checkout antes da próxima
- Se o script crashar, git checkout -- src/ reverte tudo
- Não commita nada
- Não modifica testes
"""

import os
import re
import sys
import subprocess
import time
import json
from pathlib import Path
from datetime import datetime

# ─── Configuration ───────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).parent.parent
SRC_DIR = PROJECT_ROOT / "src"
TESTS_DIR = SRC_DIR / "__tests__"
REPORT_DIR = PROJECT_ROOT / "reports" / "mutation"

# Mutations to apply: (regex_pattern, replacement, description)
# Each mutation is applied ONE AT A TIME at ONE POSITION in the file.
MUTATIONS = [
    # Comparison operators
    (r'===', '!==', '=== → !=='),
    (r'!==', '===', '!== → ==='),
    (r'(?<![<>=!])=(?!=)', '===', '= → ==='),  # assignment → strict eq (dangerous!)
    
    # Relational
    (r'(?<![<>=])>(?!=)', '>=', '> → >='),
    (r'(?<![<>=])<(?!=)', '<=', '< → <='),
    (r'>=', '>', '>= → >'),
    (r'<=', '<', '<= → <'),
    
    # Boolean flips
    (r'return\s+true\b', 'return false', 'return true → return false'),
    (r'return\s+false\b', 'return true', 'return false → return true'),
    
    # Logical operators
    (r'&&', '||', '&& → ||'),
    (r'\|\|', '&&', '|| → &&'),
    
    # Arithmetic
    (r'(?<=[\w\)])\+(?![+=])', '-', '+ → -'),
    (r'(?<=[\w\)])-(?![-=])', '+', '- → +'),
    
    # Off-by-one
    (r'\b0\b(?!\d)', '1', '0 → 1'),
    (r'\b1\b(?!\d)', '0', '1 → 0'),
]

# Files to skip (no useful mutations or too complex)
SKIP_FILES = {
    "index.ts",  # entry point, mostly imports
    "logger.ts",  # side-effect heavy
}

# Maximum mutations per file (0 = unlimited)
MAX_MUTATIONS_PER_FILE = 0  # 0 = all

# Timeout for each test run (seconds)
TEST_TIMEOUT = 30

# ─── Helpers ─────────────────────────────────────────────────────────────────

def find_test_files(source_file: str) -> list[str]:
    """Find test files that match the source file name."""
    basename = Path(source_file).stem
    patterns = [
        f"{basename}.test.ts",
        f"{basename}.test.tsx",
        f"{basename}-extended.test.ts",
        f"{basename}-extended.test.tsx",
        f"{basename}-deep.test.ts",
        f"{basename}-coverage.test.ts",
        f"{basename}-full.test.ts",
    ]
    
    found = []
    for pattern in patterns:
        path = TESTS_DIR / pattern
        if path.exists():
            found.append(str(path))
    
    # Also check for glob match
    for f in TESTS_DIR.glob(f"{basename}*.test.ts"):
        rel = str(f)
        if rel not in found:
            found.append(rel)
    for f in TESTS_DIR.glob(f"{basename}*.test.tsx"):
        rel = str(f)
        if rel not in found:
            found.append(rel)
    
    return found


def find_mutation_points(content: str, filepath: str) -> list[dict]:
    """Find all positions where mutations can be applied."""
    points = []
    lines = content.split('\n')
    
    for line_num, line in enumerate(lines, 1):
        # Skip comments and strings (simplified)
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('*') or stripped.startswith('/*'):
            continue
        if stripped.startswith('import ') or stripped.startswith('export type'):
            continue
        
        for pattern, replacement, desc in MUTATIONS:
            for match in re.finditer(pattern, line):
                pos = match.start()
                # Get context (5 chars before and after)
                ctx_start = max(0, pos - 10)
                ctx_end = min(len(line), pos + match.end() - match.start() + 10)
                context = line[ctx_start:ctx_end].strip()
                
                points.append({
                    'line': line_num,
                    'col': pos,
                    'pattern': pattern,
                    'replacement': replacement,
                    'desc': desc,
                    'original': match.group(),
                    'context': context,
                    'line_content': line,
                })
    
    return points


def apply_mutation(filepath: str, content: str, mutation: dict) -> str:
    """Apply a single mutation to the file content."""
    lines = content.split('\n')
    line_idx = mutation['line'] - 1
    line = lines[line_idx]
    
    # Replace only the FIRST occurrence on this line at this column
    col = mutation['col']
    orig = mutation['original']
    repl = mutation['replacement']
    
    # Find the exact position and replace
    new_line = line[:col] + repl + line[col + len(orig):]
    lines[line_idx] = new_line
    
    return '\n'.join(lines)


def run_tests(test_files: list[str]) -> tuple[bool, str]:
    """Run vitest on the test files. Returns (passed, output)."""
    if not test_files:
        return True, "No test files found — mutation survives by default"
    
    cmd = ['npx', 'vitest', 'run', '--reporter=dot'] + test_files
    try:
        result = subprocess.run(
            cmd,
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT,
            env={**os.environ, 'NODE_ENV': 'test'},
        )
        # Check if tests passed (exit code 0)
        passed = result.returncode == 0
        output = result.stdout + result.stderr
        return passed, output[-500:] if len(output) > 500 else output
    except subprocess.TimeoutExpired:
        return True, f"TIMEOUT after {TEST_TIMEOUT}s — assuming pass (mutation not caught)"
    except Exception as e:
        return True, f"ERROR running tests: {e}"


def revert_file(filepath: str):
    """Revert file to original state using git checkout."""
    try:
        subprocess.run(
            ['git', 'checkout', '--', filepath],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            timeout=10,
        )
    except Exception:
        pass


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    start_time = time.time()
    
    # Parse args
    quick_mode = '--quick' in sys.argv
    specific_files = [a for a in sys.argv[1:] if not a.startswith('--')]
    
    max_per_file = 5 if quick_mode else MAX_MUTATIONS_PER_FILE
    
    # Find source files to mutate
    if specific_files:
        source_files = []
        for f in specific_files:
            full = PROJECT_ROOT / f if not os.path.isabs(f) else Path(f)
            if full.exists():
                source_files.append(str(full))
    else:
        source_files = []
        for f in SRC_DIR.glob('*.ts'):
            if f.name in SKIP_FILES:
                continue
            source_files.append(str(f))
    
    print(f"╔══════════════════════════════════════════════════════════╗")
    print(f"║  Stryker Caseiro — Mutation Testing                     ║")
    print(f"╠══════════════════════════════════════════════════════════╣")
    print(f"║  Arquivos: {len(source_files):>3}                                      ║")
    print(f"║  Modo: {'quick (5/arquivo)' if quick_mode else 'completo':>22}                  ║")
    print(f"║  Timeout: {TEST_TIMEOUT}s por mutação                         ║")
    print(f"╚══════════════════════════════════════════════════════════╝")
    print()
    
    # Results
    total_mutations = 0
    killed = 0
    survived = 0
    timed_out = 0
    errors = 0
    survived_details = []
    
    for file_idx, source_file in enumerate(source_files):
        rel_path = os.path.relpath(source_file, PROJECT_ROOT)
        basename = Path(source_file).stem
        
        # Find test files
        test_files = find_test_files(source_file)
        if not test_files:
            print(f"  ⏭️  {rel_path} — sem testes, pulando")
            continue
        
        # Read source content
        with open(source_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Find mutation points
        points = find_mutation_points(content, source_file)
        
        if max_per_file > 0 and len(points) > max_per_file:
            points = points[:max_per_file]
        
        if not points:
            continue
        
        print(f"\n📊 {rel_path} — {len(points)} mutações")
        
        file_killed = 0
        file_survived = 0
        
        for i, mutation in enumerate(points):
            total_mutations += 1
            desc = mutation['desc']
            ctx = mutation['context'][:40]
            
            # Apply mutation
            mutated_content = apply_mutation(source_file, content, mutation)
            with open(source_file, 'w', encoding='utf-8') as f:
                f.write(mutated_content)
            
            # Run tests
            passed, output = run_tests(test_files)
            
            # Revert
            revert_file(source_file)
            
            if passed:
                if 'TIMEOUT' in output:
                    timed_out += 1
                    status = '⏰'
                    print(f"  {status} [{i+1}/{len(points)}] {desc:25s} | {ctx}")
                else:
                    survived += 1
                    file_survived += 1
                    status = '❌'
                    print(f"  {status} [{i+1}/{len(points)}] {desc:25s} | {ctx}")
                    survived_details.append({
                        'file': rel_path,
                        'line': mutation['line'],
                        'desc': desc,
                        'context': ctx,
                    })
            else:
                killed += 1
                file_killed += 1
                status = '✅'
                if (i + 1) % 10 == 0 or i == 0:
                    print(f"  {status} [{i+1}/{len(points)}] {desc:25s} | {ctx}")
        
        mutation_score = (file_killed / len(points) * 100) if points else 0
        print(f"  → {file_killed}/{len(points)} mortas ({mutation_score:.0f}%), {file_survived} sobreviveram")
    
    elapsed = time.time() - start_time
    
    # Generate report
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
    report_file = REPORT_DIR / f'mutation-report-{timestamp}.json'
    
    report = {
        'timestamp': timestamp,
        'elapsed_seconds': round(elapsed, 1),
        'total_mutations': total_mutations,
        'killed': killed,
        'survived': survived,
        'timed_out': timed_out,
        'mutation_score': round(killed / total_mutations * 100, 1) if total_mutations else 0,
        'survived_details': survived_details,
    }
    
    with open(report_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    
    # Print summary
    print(f"\n{'═' * 60}")
    print(f"  RELATÓRIO FINAL — Stryker Caseiro")
    print(f"{'═' * 60}")
    print(f"  Tempo:           {elapsed:.0f}s")
    print(f"  Total mutações:  {total_mutations}")
    print(f"  Mortas:          {killed} ✅")
    print(f"  Sobreviveram:    {survived} ❌")
    print(f"  Timeout:         {timed_out} ⏰")
    if total_mutations:
        print(f"  Mutation Score:  {killed/total_mutations*100:.1f}%")
    print(f"  Relatório:       {report_file}")
    print(f"{'═' * 60}")
    
    if survived_details:
        print(f"\n  ❌ MUTAÇÕES SOBREVIVENTES (gaps de teste):")
        for s in survived_details[:20]:
            print(f"    {s['file']}:{s['line']} — {s['desc']} | {s['context']}")
        if len(survived_details) > 20:
            print(f"    ... e mais {len(survived_details) - 20}")
    
    # Exit code: 0 if all killed, 1 if any survived
    sys.exit(0 if survived == 0 else 1)


if __name__ == '__main__':
    main()
