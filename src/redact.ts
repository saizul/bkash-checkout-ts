const SENSITIVE_KEYS = new Set([
  'authorization',
  'password',
  'username',
  'app_key',
  'app_secret',
  'x-app-key',
  'id_token',
  'refresh_token',
]);

export const REDACTED = '[REDACTED]';

/** Returns a deep copy with credential fields replaced. */
export function redact<T>(value: T, extraSecrets: readonly string[] = []): T {
  return walk(value, extraSecrets.filter((s) => s.length >= 4)) as T;
}

function walk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return scrub(value, secrets);
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : walk(v, secrets);
    }
    return out;
  }
  return value;
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join(REDACTED);
  return out;
}

/** Masks a wallet number, keeping the last three digits: 017*****575. */
export function maskWallet(wallet: string | undefined): string | undefined {
  if (!wallet) return wallet;
  const digits = wallet.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 3)}${'*'.repeat(digits.length - 6)}${digits.slice(-3)}`;
}
