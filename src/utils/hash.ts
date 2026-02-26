import { createHash } from 'crypto';
import { createReadStream } from 'fs';

export function fileMd5(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filepath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
