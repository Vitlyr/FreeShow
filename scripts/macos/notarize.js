// From https://github.com/simonw/til/blob/main/electron/sign-notarize-electron-macos.md
// Based on https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/

const { notarize } = require("@electron/notarize")

exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context
    if (electronPlatformName !== "darwin") return

    // electron-builder's own `mac.notarize: false` only gates its built-in
    // notarize step — this is a separate custom afterSign hook, so it ran
    // (and hard-failed) unconditionally on any macOS build without these
    // three set, including unsigned local/CI dev builds. @electron/notarize
    // does a signature pre-flight check before even attempting to reach
    // Apple's servers, and that check expects a real Developer ID/hardened
    // runtime signature — an ad-hoc-only build (no cert configured) fails
    // it immediately with a signature error that has nothing to do with
    // the actual notarization credentials being missing.
    if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
        console.log("notarize: skipping — APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID not set")
        return
    }

    const appName = context.packager.appInfo.productFilename

    return await notarize({
        appBundleId: "app.freeshow",
        appPath: `${appOutDir}/${appName}.app`,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID
    })
}
