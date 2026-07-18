'use strict';

const { randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { lstat, rename, rm } = require('node:fs/promises');
const { basename, dirname, join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const yazl = require('yazl');

const MEBIBYTE = 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * MEBIBYTE;
const MAX_TOTAL_BYTES = 64 * MEBIBYTE;
const DIRECTORY_MODE = 0o40755;
const REGULAR_FILE_MODE = 0o100644;
const EXECUTABLE_FILE_MODE = 0o100755;
const EXECUTABLE_ENTRY = 'extension/out/terminateProcess.sh';
const TEMPORARY_FILE_PREFIX = '.unity-shader-nav-vsix-mode-';

async function normalizeVsixFileModes(vsixPath, options = {}) {
  const sourceStat = await lstat(vsixPath);
  if (!sourceStat.isFile()) throw new Error(`VSIX input must be a regular file: ${vsixPath}`);

  const archive = await readVsixEntries(vsixPath);
  const temporaryPath = join(
    dirname(vsixPath),
    `${TEMPORARY_FILE_PREFIX}${process.pid}-${randomUUID()}.tmp`,
  );
  const openOutput = options.createOutputStream ?? createWriteStream;
  let outputZip;
  let outputPipeline;
  let outputZipError;

  try {
    outputZip = new yazl.ZipFile();
    outputZipError = rejectionFromEvent(outputZip, 'error');
    const output = openOutput(temporaryPath, {
      flags: 'wx',
      mode: sourceStat.mode & 0o777,
    });
    outputPipeline = pipeline(outputZip.outputStream, output);

    for (const entry of archive.entries) {
      if (entry.directory) {
        outputZip.addEmptyDirectory(entry.name, {
          mtime: entry.mtime,
          mode: DIRECTORY_MODE,
        });
      } else {
        outputZip.addBuffer(entry.contents, entry.name, {
          mtime: entry.mtime,
          mode: entry.name === EXECUTABLE_ENTRY
            ? EXECUTABLE_FILE_MODE
            : REGULAR_FILE_MODE,
          compress: entry.compress,
          fileComment: entry.fileComment,
        });
      }
    }
    outputZip.end({ comment: archive.comment });
    await Promise.race([outputPipeline, outputZipError.promise]);
    outputZipError.dispose();
    await rename(temporaryPath, vsixPath);
  } catch (error) {
    outputZip?.outputStream.destroy();
    outputZipError?.dispose();
    if (outputPipeline) await outputPipeline.catch(() => undefined);
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [asError(error), asError(cleanupError)],
        `VSIX mode normalization failed and temporary output could not be removed: ${basename(temporaryPath)}`,
      );
    }
    throw error;
  }
}

async function readVsixFileModes(vsixPath) {
  const zip = await openZip(vsixPath);
  return new Promise((resolvePromise, reject) => {
    const modes = new Map();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(asError(error));
    };
    zip.once('error', fail);
    zip.on('entry', (entry) => {
      if (settled) return;
      modes.set(entry.fileName, entry.externalFileAttributes >>> 16);
      requestNextEntry(zip, fail);
    });
    zip.once('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(modes);
    });
    requestNextEntry(zip, fail);
  });
}

async function readVsixEntries(vsixPath) {
  const zip = await openZip(vsixPath);
  return new Promise((resolvePromise, reject) => {
    const entries = [];
    let executableEntries = 0;
    let totalBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(asError(error));
    };

    zip.once('error', fail);
    zip.on('entry', (entry) => {
      if (settled) return;
      void readEntry(entry).then(
        () => requestNextEntry(zip, fail),
        fail,
      );
    });
    zip.once('end', () => {
      if (settled) return;
      if (executableEntries !== 1) {
        fail(new Error(
          `VSIX must contain exactly one ${EXECUTABLE_ENTRY} entry; found ${executableEntries}`,
        ));
        return;
      }
      settled = true;
      resolvePromise({ entries, comment: zip.comment });
    });
    requestNextEntry(zip, fail);

    async function readEntry(entry) {
      const metadata = {
        name: entry.fileName,
        mtime: entry.getLastModDate(),
        directory: entry.fileName.endsWith('/'),
      };
      if (metadata.directory) {
        entries.push(metadata);
        return;
      }

      if (entry.fileName === EXECUTABLE_ENTRY && ++executableEntries > 1) {
        throw new Error(`VSIX contains duplicate ${EXECUTABLE_ENTRY} entries`);
      }
      if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
        throw new Error(`${entry.fileName} exceeds the 32 MiB entry limit`);
      }
      if (totalBytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
        throw new Error('VSIX entries exceed the 64 MiB total uncompressed-size limit');
      }
      totalBytes += entry.uncompressedSize;
      const readStream = await openEntryReadStream(zip, entry);
      entries.push({
        ...metadata,
        contents: await readExactly(readStream, entry.uncompressedSize, entry.fileName),
        compress: entry.compressionMethod !== 0,
        fileComment: entry.fileComment,
      });
    }
  });
}

function readExactly(readStream, expectedBytes, entryName) {
  return new Promise((resolvePromise, reject) => {
    const contents = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    readStream.on('data', (chunk) => {
      if (offset + chunk.length > expectedBytes) {
        readStream.destroy();
        reject(new Error(`${entryName} exceeds its declared uncompressed size`));
        return;
      }
      chunk.copy(contents, offset);
      offset += chunk.length;
    });
    readStream.once('error', reject);
    readStream.once('end', () => {
      if (offset !== expectedBytes) {
        reject(new Error(
          `${entryName} contains ${offset} bytes; expected ${expectedBytes}`,
        ));
      } else {
        resolvePromise(contents);
      }
    });
  });
}

function openEntryReadStream(zip, entry) {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, readStream) => {
      if (error) reject(error);
      else resolvePromise(readStream);
    });
  });
}

function requestNextEntry(zip, fail) {
  try {
    zip.readEntry();
  } catch (error) {
    fail(error);
  }
}

function openZip(vsixPath) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(vsixPath, {
      autoClose: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zip) => {
      if (error) reject(error);
      else resolvePromise(zip);
    });
  });
}

function rejectionFromEvent(emitter, event) {
  let rejectPromise;
  const promise = new Promise((_, reject) => {
    rejectPromise = reject;
  });
  const listener = (error) => rejectPromise(asError(error));
  emitter.once(event, listener);
  return {
    promise,
    dispose: () => emitter.removeListener(event, listener),
  };
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

module.exports = {
  normalizeVsixFileModes,
  readVsixFileModes,
};
