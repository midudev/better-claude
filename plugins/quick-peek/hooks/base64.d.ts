// The engine's environment has the ES2026 base64 methods; the es2023 lib the types use does not.
declare global {
  interface Uint8Array {
    toBase64 (): string
  }
  interface Uint8ArrayConstructor {
    fromBase64 (base64: string): Uint8Array
  }
}

export {}
