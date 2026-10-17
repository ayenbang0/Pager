declare module 'hyperdht' {
  import type { Duplex } from 'node:stream'
  export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
  export type BootstrapNode = string | { host: string; port: number }
  export interface PeerSocket extends Duplex { readonly remotePublicKey: Buffer; readonly publicKey: Buffer; setTimeout(ms: number): void }
  export interface DHTServer {
    on(event: 'connection', cb: (socket: PeerSocket) => void): this
    on(event: 'listening' | 'close', cb: () => void): this
    listen(keyPair: KeyPair): Promise<void>
    close(): Promise<void>
  }
  export interface DHTOptions { bootstrap?: BootstrapNode[]; keyPair?: KeyPair; [key: string]: unknown }
  export default class DHT {
    static keyPair(seed?: Buffer): KeyPair
    constructor(opts?: DHTOptions)
    /** `firewall` returns true to REJECT the remote peer. */
    createServer(opts?: { firewall?: (remotePublicKey: Buffer, payload: unknown) => boolean }): DHTServer
    connect(remotePublicKey: Buffer | string, opts?: { keyPair?: KeyPair }): PeerSocket
    destroy(opts?: { force?: boolean }): Promise<void>
    ready(): Promise<void>
    refresh(): void
    /** Routing table nodes. */
    readonly nodes: { readonly length: number }
    readonly online: boolean
    readonly degraded: boolean
    readonly firewalled: boolean
    readonly randomized: boolean
    readonly host: string | null
    readonly port: number
    on(event: 'network-change', cb: () => void): this
  }
}
declare module 'hyperdht/testnet.js' {
  export interface Testnet { bootstrap: Array<{ host: string; port: number }>; destroy(): Promise<void> }
  export default function createTestnet(size?: number, opts?: { host?: string; port?: number }): Promise<Testnet>
}
declare module 'hypercore-crypto' {
  const crypto: {
    randomBytes(n: number): Buffer
    sign(message: Buffer, secretKey: Buffer): Buffer
    verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean
  }
  export default crypto
}
declare module 'z32' {
  export function encode(buf: Buffer | Uint8Array): string
  export function decode(s: string): Buffer
}
