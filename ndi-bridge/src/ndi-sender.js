const ndi = require("@vygr-labs/ndi-node");

class NdiVideoSender {
  /**
   * @param {{ name: string, width: number, height: number, fps: number, groups?: string }} opts
   */
  constructor(opts) {
    this.width = opts.width;
    this.height = opts.height;
    this.fps = opts.fps;
    this.frameRateN = opts.fps;
    this.frameRateD = 1;
    this._bgraPool = Buffer.allocUnsafe(opts.width * opts.height * 4);

    if (!ndi.initialize()) {
      throw new Error("NDI initialize() failed — is NDI Runtime installed?");
    }

    this.sender = new ndi.Sender({
      name: opts.name,
      groups: opts.groups != null && String(opts.groups).length ? opts.groups : "Public",
      clockVideo: true,
      clockAudio: false,
    });
  }

  /**
   * @param {Buffer|Uint8Array} rgba
   */
  async sendRgbaFrame(rgba) {
    const { rgbaToBgra } = require("./rgba-to-bgra");
    const data = rgbaToBgra(rgba, this._bgraPool);
    await this.sender.sendVideoAsync({
      xres: this.width,
      yres: this.height,
      fourCC: ndi.FourCC.BGRA,
      frameRateN: this.frameRateN,
      frameRateD: this.frameRateD,
      frameFormatType: ndi.FrameFormat.PROGRESSIVE,
      data,
    });
  }

  async getConnections() {
    return this.sender.getConnectionsAsync(0);
  }

  destroy() {
    if (this.sender) {
      this.sender.destroy();
      this.sender = null;
    }
    ndi.destroy();
  }
}

module.exports = { NdiVideoSender };
