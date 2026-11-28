import { createHash } from 'node:crypto';
import { swapPositions } from '../../src/weread/protocol.ts';

export function encodeShards(source: string, count: number) {
    const base64 = Buffer.from(source).toString('base64url');
    const encoded = [...base64];
    const positions = swapPositions(base64);
    for (let index = 0; index < positions.length; index += 2) {
        const left = positions[index];
        const right = positions[index + 1];
        if (left === undefined || right === undefined) throw new Error('Invalid shard positions');
        for (const offset of [0, 1]) {
            const first = encoded[left + offset];
            const second = encoded[right + offset];
            if (first === undefined || second === undefined)
                throw new Error('Invalid shard offsets');
            encoded[left + offset] = second;
            encoded[right + offset] = first;
        }
    }
    const payload = 'Z' + encoded.join('');
    const length = Math.ceil(payload.length / count);
    return Array.from({ length: count }, (_, index) => {
        const shard = payload.slice(index * length, (index + 1) * length);
        return createHash('md5').update(shard).digest('hex').toUpperCase() + shard;
    });
}
