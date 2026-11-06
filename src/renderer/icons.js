/**
 * VERIDEX — interface icon set.
 *
 * Every icon is drawn from the same primitives: a 24×24 box, 1.6 stroke, round caps and joins,
 * no fill, `currentColor`. That is what makes a navigation rail look like one set rather than a
 * collection of borrowed pictures, and it is why these are inline SVG rather than a font or an
 * emoji.
 *
 * The previous navigation used typographic glyphs (`◈`, `⌘`, `⚡`, `⛨`). Windows resolves several
 * of those through its emoji font, so the rail rendered as a mixture of coloured pictograms -
 * a fuel pump beside a monochrome diamond - which no amount of spacing fixes. It also meant the
 * icons could not take the accent colour, because an emoji glyph ignores `color`.
 *
 * Shapes are described rather than painted: `paths` are stroked, `shapes` are primitives. A test
 * asserts that every page has an icon and that every icon is inside the viewBox, so a page added
 * without one fails the build instead of rendering an empty square.
 */

/** @typedef {{paths?: string[], circles?: Array<[number, number, number]>, rects?: Array<[number, number, number, number, number?]>}} IconShape */

/** @type {Record<string, IconShape>} */
export const ICONS = Object.freeze({
  dashboard: {
    rects: [
      [3.5, 3.5, 7, 7, 1.5],
      [13.5, 3.5, 7, 4.5, 1.5],
      [13.5, 10.5, 7, 10, 1.5],
      [3.5, 13, 7, 7.5, 1.5]
    ]
  },
  hardware: {
    rects: [[6.5, 6.5, 11, 11, 2]],
    paths: [
      'M9.5 9.5h5v5h-5z',
      'M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21',
      'M6.5 3v1.5M17.5 3v1.5M6.5 19.5V21M17.5 19.5V21',
      'M3 6.5h1.5M19.5 6.5H21M3 17.5h1.5M19.5 17.5H21'
    ]
  },
  battery: {
    rects: [[2.5, 8, 16, 8, 2]],
    paths: ['M21.5 11v2', 'M5.5 11v2M8.5 11v2M11.5 11v2']
  },
  storage: {
    paths: [
      'M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5-8-1.1-8-2.5z',
      'M4 6.5v11c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-11',
      'M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5'
    ]
  },
  network: {
    paths: ['M3.5 9.5a13 13 0 0 1 17 0', 'M6.5 13a8.5 8.5 0 0 1 11 0', 'M9.5 16.5a4 4 0 0 1 5 0'],
    circles: [[12, 20, 1.2]]
  },
  windows: {
    paths: ['M12 3.2 19 6v5.8c0 4.1-2.9 6.8-7 9-4.1-2.2-7-4.9-7-9V6z', 'M9 12l2.2 2.2L15.5 10']
  },
  reliability: {
    circles: [[12, 12, 8.5]],
    paths: ['M12 7.5V12l3 2']
  },
  drivers: {
    circles: [[12, 12, 3.2]],
    paths: [
      'M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6',
      'M5.6 5.6 7.4 7.4M16.6 16.6l1.8 1.8M18.4 5.6 16.6 7.4M7.4 16.6l-1.8 1.8'
    ]
  },
  processes: {
    paths: ['M8.5 6.5H21M8.5 12H21M8.5 17.5H21'],
    circles: [[4.5, 6.5, 1.2], [4.5, 12, 1.2], [4.5, 17.5, 1.2]]
  },
  manual: {
    circles: [[12, 12, 8.5], [12, 12, 3.4]],
    paths: ['M12 1.5v3.2M12 19.3v3.2M1.5 12h3.2M19.3 12h3.2']
  },
  performance: {
    paths: ['M13.4 2.5 5.2 13.4h5.6l-1.2 8.1 8.2-10.9h-5.6z']
  },
  monitor: {
    paths: ['M3.5 16.5 8.5 10l3.6 3.6L20.5 5.5', 'M3.5 20.5h17']
  },
  reports: {
    paths: ['M6.5 2.8h7.2l4.3 4.3v14.1h-11.5z', 'M13.7 2.8v4.3h4.3', 'M9 12.5h6M9 16.5h6']
  },
  history: {
    paths: ['M20.2 12a8.2 8.2 0 1 1-3.4-6.6', 'M20.6 3.4v5.1h-5.1']
  },
  settings: {
    paths: ['M4 7h7.5M16.5 7H20', 'M4 17h3.5M12.5 17H20', 'M4 12h11.5M20 12h-1'],
    circles: [[14, 7, 1.8], [10, 17, 1.8], [17.5, 12, 1.8]]
  },
  privacy: {
    rects: [[4.5, 10.5, 15, 10.5, 2.2]],
    paths: ['M8 10.5V7.5a4 4 0 0 1 8 0v3', 'M12 14.5v2.5']
  },
  logs: {
    rects: [[2.8, 4.5, 18.4, 15, 2.2]],
    paths: ['M6.8 9.5 9.8 12l-3 2.5', 'M12.5 15h4.5']
  },
  about: {
    circles: [[12, 12, 8.8]],
    paths: ['M12 10.8v5.6', 'M12 7.6v.4']
  }
});

/** Names, in the order the navigation uses them. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));
