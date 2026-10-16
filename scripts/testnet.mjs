import createTestnet from 'hyperdht/testnet.js'
const t = await createTestnet(3)
console.log('PAGER_BOOTSTRAP=' + t.bootstrap.map((b) => `${b.host}:${b.port}`).join(','))
process.on('SIGINT', async () => { await t.destroy(); process.exit(0) })
setInterval(() => {}, 1 << 30)
