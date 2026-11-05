/**
 * The PE version-info parser, against a block built the way Windows builds one.
 *
 * This parser produced "FileDescription" as the product version on the first real build it
 * ever saw, because VS_VERSIONINFO pads between a key and its value and the naive version
 * read the next key instead. It is exactly the kind of bug that cannot be found without
 * either a real binary or a faithful fixture, so here is the fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readVersionStrings, readPe } from '../../scripts/verify-package.mjs';

/** Align a buffer to a 4-byte boundary, filling with NUL. */
function align(buffer) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding)]);
}

/** Build a minimal VS_VERSIONINFO StringFileInfo block. */
function versionBlock(pairs) {
  const parts = [];
  for (const [key, value] of pairs) {
    parts.push(align(Buffer.from(`${key}\u0000`, 'utf16le')));
    parts.push(align(Buffer.from(`${value}\u0000`, 'utf16le')));
  }
  return Buffer.concat(parts);
}

test('reads each value, not the next key', () => {
  const block = versionBlock([
    ['CompanyName', 'MERQO'],
    ['FileDescription', 'VERIDEX hardware diagnostics'],
    ['FileVersion', '1.0.0'],
    ['ProductName', 'VERIDEX'],
    ['ProductVersion', '1.0.0']
  ]);
  const result = readVersionStrings(block);

  assert.equal(result.companyName, 'MERQO');
  assert.equal(result.fileDescription, 'VERIDEX hardware diagnostics');
  assert.equal(result.productVersion, '1.0.0', 'ProductVersion must be a version, never the next key name');
  assert.equal(result.productName, 'VERIDEX');
});

test('a missing key reads as null rather than as a neighbour', () => {
  const block = versionBlock([
    ['CompanyName', 'MERQO'],
    ['ProductVersion', '2.5.1']
  ]);
  const result = readVersionStrings(block);
  assert.equal(result.productVersion, '2.5.1');
  assert.equal(result.originalFilename, null);
  assert.equal(result.productName, null);
});

test('a real PE header is recognised and its architecture reported', () => {
  // A minimal but structurally valid PE32+ image for x64.
  const buffer = Buffer.alloc(0x100);
  buffer.writeUInt16LE(0x5a4d, 0); // MZ
  buffer.writeUInt32LE(0x40, 0x3c); // e_lfanew
  buffer.writeUInt32LE(0x0000_4550, 0x40); // PE\0\0
  buffer.writeUInt16LE(0x8664, 0x44); // machine = x64
  buffer.writeUInt16LE(0x0002, 0x40 + 22); // IMAGE_FILE_EXECUTABLE_IMAGE
  buffer.writeUInt16LE(0x20b, 0x40 + 24); // PE32+

  const pe = readPe(buffer);
  assert.equal(pe.ok, true);
  assert.equal(pe.machine, 'x64');
  assert.equal(pe.isExecutable, true);
  assert.equal(pe.magic, 'PE32+');
});

test('a file that is not an executable is rejected with a reason', () => {
  assert.equal(readPe(Buffer.from('#!/bin/sh\necho nope\n')).ok, false);
  const truncated = Buffer.alloc(0x100);
  truncated.writeUInt16LE(0x5a4d, 0);
  truncated.writeUInt32LE(0xffff, 0x3c); // header offset past the end
  const result = readPe(truncated);
  assert.equal(result.ok, false);
  assert.match(result.reason, /past the end|no PE/);
});
