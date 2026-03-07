declare module 'node-wav' {
    interface DecodeResult {
        sampleRate: number;
        channelData: Float32Array[];
        bitDepth: number;
    }

    function decode(buffer: Buffer | ArrayBuffer): DecodeResult;

    function encode(channelData: Float32Array[], options: {
        sampleRate: number;
        float?: boolean;
        bitDepth?: number;
    }): Buffer;
}
