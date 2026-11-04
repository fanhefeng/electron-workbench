export function shellCSP(nonce?: string): string {
  return `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${nonce ? "'self' ws://127.0.0.1:5197" : "'none'"}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
}
