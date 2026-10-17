import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const zstdCodec = {
  compress: (data: Uint8Array, level?: number, checksum?: boolean): Buffer => {
    if (level === undefined && checksum === undefined) {
      return zstdCompressSync(data);
    }
    return zstdCompressSync(data, {
      params: {
        ...(level === undefined ? {} : { [constants.ZSTD_c_compressionLevel]: level }),
        ...(checksum === undefined ? {} : { [constants.ZSTD_c_checksumFlag]: checksum }),
      },
    });
  },
  decompress: (data: Uint8Array, maxOutputLength?: number): Buffer => {
    return zstdDecompressSync(
      data,
      maxOutputLength === undefined ? undefined : { maxOutputLength },
    );
  },
};
