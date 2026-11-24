import { spawn } from 'node:child_process';

// timeoutMs: se o processo passar disso (ex.: conexão de rede pendurada), ele e seus
// filhos são encerrados e a promessa falha — assim a fila nunca fica travada para sempre.
export function run(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: process.env, detached: true });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* já saiu */ } }
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`Falha ao executar ${cmd}: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} travou e foi encerrado após ${Math.round(timeoutMs / 1000)}s sem terminar`));
      else if (code === 0) resolve(out);
      else reject(new Error(`${cmd} saiu com código ${code}: ${err.slice(-1500)}`));
    });
  });
}

export async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 60 * 1000 });
  return parseFloat(out.trim()) || 0;
}
