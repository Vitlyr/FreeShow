// Live sync client connecting out to the Song Library web app's WebSocket
// server at /api/sync (see that project's lib/syncServer.js for the wire
// protocol this will eventually speak — JSON envelopes {v:1, type, payload}
// with song_upsert/song_delete/project_upsert/project_delete messages).
//
// Stubbed for now: just tracks the configured enabled/ip/port state and
// logs connect/disconnect/reconfigure. The real WebSocket connection,
// reconnect-with-backoff, and inbound merge into the SHOWS/PROJECTS stores
// land in a later step.
let current: { enabled: boolean; ip: string; port: number } | null = null

export function updateSongLibrarySync(data: { enabled: boolean; ip: string; port: number }) {
    const wasEnabled = current?.enabled === true

    if (data.enabled && !wasEnabled) {
        console.log(`songLibraryClient: connect (stub) -> ${data.ip}:${data.port}`)
    } else if (!data.enabled && wasEnabled) {
        console.log("songLibraryClient: disconnect (stub)")
    } else if (data.enabled) {
        console.log(`songLibraryClient: reconfigure (stub) -> ${data.ip}:${data.port}`)
    }

    current = data
}
