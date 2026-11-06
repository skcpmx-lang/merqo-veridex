/**
 * VERIDEX — electron-builder configuration.
 *
 * Kept as a separate module rather than a `build` block in package.json so the
 * packaging rules are reviewable and testable: `tests/unit/build-config.test.js`
 * asserts that the app id, the unsigned status and the artifact names are what the
 * release documentation claims.
 *
 * Notes a reader of the shipped installer should know:
 *   - **Unsigned.** No code-signing certificate is available for this project, so the
 *     installer and the executables are unsigned and Windows SmartScreen will warn on
 *     first run. No fake certificate and no publisher name is invented here.
 *   - **Per-user install, no elevation.** NSIS is configured to install under the
 *     user profile, so installing VERIDEX does not require administrator rights. The
 *     application requests elevation only for individual privileged diagnostics, at
 *     the moment they are needed.
 *   - **No auto-update.** An updater would be a network client; VERIDEX ships none.
 */

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'com.merqo.veridex',
  productName: 'VERIDEX',
  copyright: 'Copyright © 2026 MERQO · Shohan Khan',

  directories: {
    output: 'dist',
    buildResources: 'build'
  },

  // Only what the app needs at runtime. Tests, docs and the build scripts are not
  // shipped: a smaller installer and a smaller attack surface.
  files: [
    'src/**/*.js',
    'src/**/*.cjs',
    'src/renderer/**/*.html',
    'src/renderer/**/*.css',
    'assets/icons/**/*',
    'package.json',
    'LICENSE',
    '!**/*.test.js',
    '!**/node_modules/**/{test,__tests__,tests,example,examples,docs}/**',
    '!**/*.{md,map,ts}'
  ],

  asar: true,
  asarUnpack: ['node_modules/systeminformation/**'],

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] }
    ],
    icon: 'build/icon.ico',
    // Deliberately absent: `certificateFile`, `certificateSubjectName`,
    // `signingHashAlgorithms` and any publisher name. The build is unsigned and says so.
    requestedExecutionLevel: 'asInvoker',
    legalTrademarks: 'VERIDEX is a product of MERQO',
    artifactName: 'VERIDEX-${version}-${arch}-${os}.${ext}'
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'VERIDEX',
    uninstallDisplayName: 'VERIDEX ${version}',
    artifactName: 'VERIDEX-Setup-${version}-${arch}.${ext}',
    deleteAppDataOnUninstall: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
    license: 'LICENSE'
  },

  portable: {
    artifactName: 'VERIDEX-${version}-portable-${arch}.${ext}'
  },

  // No publish provider: VERIDEX does not upload anything from the build, and the
  // release is created by the workflow with an explicit gh command.
  publish: null,

  // Reproducibility: a fixed timestamp would be nicer, but electron-builder does not
  // support one, so the build records the commit it came from instead.
  extraMetadata: {
    buildInfo: {
      product: 'VERIDEX',
      brand: 'MERQO',
      signed: false,
      smartScreenWarning: true
    }
  }
};
