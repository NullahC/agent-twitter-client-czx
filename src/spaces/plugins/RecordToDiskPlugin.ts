import * as fs from 'fs';
import * as path from 'path';
import { AudioDataWithUser, Plugin } from '../types';

type AudioCallback = (data: Int16Array, userId?: string) => void;

export class RecordToDiskPlugin implements Plugin {
  private fileDescriptor: number;
  private outStream: fs.WriteStream;
  private onAudioCallback?: AudioCallback;

  // 这几个字段，用来在第一次拿到音频时写 WAV 头部，以及在结束时回填长度
  private headerWritten = false;
  private totalDataBytes = 0; // 统计写入的 PCM 字节数（不含 WAV 头）
  private wavSampleRate = 0;
  private wavBitsPerSample = 0;
  private wavNumChannels = 0;

  constructor(
    outputPath = '/tmp/speaker_audio.wav',
    onAudioCallback?: AudioCallback
  ) {
    // 我们直接 openSync，以便后续可以 random access 写 header
    // 'w' 模式表示若文件存在会被清空；若不存在就新建
    this.fileDescriptor = fs.openSync(outputPath, 'w');
    this.outStream = fs.createWriteStream('', { fd: this.fileDescriptor });
    this.onAudioCallback = onAudioCallback;

    console.log(`[RecordToDiskPlugin] WAV file will be written to: ${outputPath}`);
  }

  onAudioData(data: AudioDataWithUser): void {
    // 这里包含了：bitsPerSample、sampleRate、channelCount、samples、numberOfFrames 等
    const {
      bitsPerSample,
      sampleRate,
      channelCount,
      samples,
    } = data;

    // 如果还没写过header，就先写一个44字节的WAV头（占位）
    if (!this.headerWritten) {
      this.wavSampleRate = sampleRate;
      this.wavBitsPerSample = bitsPerSample;
      this.wavNumChannels = channelCount;
      this.writeWavHeaderPlaceholder();
      this.headerWritten = true;
    }

    // 把PCM数据写到文件
    const pcmBuf = Buffer.from(samples.buffer);
    this.outStream.write(pcmBuf);
    this.totalDataBytes += pcmBuf.length;

    // 如果要做自定义处理，就调用回调
    if (this.onAudioCallback) {
      this.onAudioCallback(samples, data.userId);
    }
  }

  // Space 停止/插件清理时关闭文件流，并回写WAV头的正确大小
  cleanup(): void {
    console.log('[RecordToDiskPlugin] cleanup => finalizing WAV file...');

    // 如果从来没写过数据，就啥也不做（可以根据需求来处理是否需要写个空WAV头）
    if (this.headerWritten && this.totalDataBytes > 0) {
      this.updateWavHeaderSizes();
    }

    this.outStream.end(() => {
      // fs.closeSync 也可以，但 outStream.end() 会帮我们 close FD
      console.log('[RecordToDiskPlugin] WAV file closed.');
    });
  }

  /**
   * 一次性写下WAV头的 44 字节占位内容，后面再在 cleanup() 时回填一些大小字段
   */
  private writeWavHeaderPlaceholder() {
    // 先构造一个 44 字节的 Buffer，全填 0
    const header = Buffer.alloc(44, 0);

    // 写入 'RIFF'
    header.write('RIFF', 0);
    // [4..7] 会是chunk size(文件总大小-8)，我们先占位 0，最后再补
    // 写入 'WAVE'
    header.write('WAVE', 8);
    // 写入 'fmt '
    header.write('fmt ', 12);

    // subchunk1Size = 16 for PCM
    header.writeUInt32LE(16, 16);
    // audioFormat = 1 for PCM
    header.writeUInt16LE(1, 20);
    // numChannels
    header.writeUInt16LE(this.wavNumChannels, 22);
    // sampleRate
    header.writeUInt32LE(this.wavSampleRate, 24);
    // byteRate = sampleRate * numChannels * bitsPerSample/8
    const byteRate = this.wavSampleRate * this.wavNumChannels * (this.wavBitsPerSample / 8);
    header.writeUInt32LE(byteRate, 28);
    // blockAlign = numChannels * bitsPerSample/8
    const blockAlign = this.wavNumChannels * (this.wavBitsPerSample / 8);
    header.writeUInt16LE(blockAlign, 32);
    // bitsPerSample
    header.writeUInt16LE(this.wavBitsPerSample, 34);

    // 写入 'data'
    header.write('data', 36);
    // [40..43] 会是subchunk2Size(PCM数据大小)，先占位 0

    // 通过 fs.writeSync(...) 把这个头写进去
    fs.writeSync(this.fileDescriptor, header, 0, 44, 0);
  }

  /**
   * 在 cleanup() 时，知道了 totalDataBytes，就可以把 chunk size 和 data size 回填进头部
   */
  private updateWavHeaderSizes() {
    // riff chunk size = 36 + totalDataBytes (不含前8字节)
    const fileSizeMinus8 = 36 + this.totalDataBytes;
    // data subchunk size = totalDataBytes
    const dataSize = this.totalDataBytes;

    // 回写 chunk size
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(fileSizeMinus8, 0);
    fs.writeSync(this.fileDescriptor, buf, 0, 4, 4);

    // 回写 dataSize
    buf.writeUInt32LE(dataSize, 0);
    fs.writeSync(this.fileDescriptor, buf, 0, 4, 40);

    console.log(`[RecordToDiskPlugin] WAV header updated: fileSize=${fileSizeMinus8+8}, dataSize=${dataSize},wavBitsPerSample=${this.wavBitsPerSample},wavSampleRate=${this.wavSampleRate},wavNumChannels=${this.wavNumChannels}`);
  }
}
