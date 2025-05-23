import renderIcon from "@holo-host/identicon";
import { HoloHash, encodeHashToBase64 } from "@holochain/client";
import { localized, msg } from "@lit/localize";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";
import SlTooltip from "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";
import {
  HoloHashMap,
  MemoHoloHashMap,
  MemoMap,
} from "@darksoil-studio/holochain-utils";
import { LitElement, PropertyValues, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import { hashProperty } from "../holo-hash-property.js";

const canvasCache = new MemoHoloHashMap(
  (hash) =>
    new MemoMap((size: number) => {
      const canvas = document.createElement("canvas");

      renderIcon(
        {
          hash: hash,
          size: size,
        },
        canvas,
      );

      return canvas;
    }),
);

@localized()
@customElement("holo-identicon")
export class HoloIdenticon extends LitElement {
  @property(hashProperty("hash"))
  hash!: HoloHash;

  /**
   * Size of the identicon in pixels.
   */
  @property({ type: Number })
  size = 32;

  /**
   * Shape of the identicon.
   */
  @property({ type: String })
  shape: "square" | "circle" = "circle";

  /**
   * Disables showing the tooltip for the hash
   */
  @property({ type: Boolean, attribute: "disable-tooltip" })
  disableTooltip = false;

  /**
   * Disable copying of the hash on click
   */
  @property({ type: Boolean, attribute: "disable-copy" })
  disableCopy = false;

  @query("#canvas")
  private _canvas!: HTMLCanvasElement;

  @query("#tooltip")
  private _tooltip!: SlTooltip;

  @state()
  justCopiedHash = false;

  timeout: any;

  async copyHash() {
    if (this.disableCopy) return;

    await navigator.clipboard.writeText(this.strHash);

    if (this.timeout) clearTimeout(this.timeout);

    this.justCopiedHash = true;
    this._tooltip.show();

    this.timeout = setTimeout(() => {
      this._tooltip.hide();
      setTimeout(() => {
        this.justCopiedHash = false;
      }, 100);
    }, 2000);
  }

  get strHash() {
    return encodeHashToBase64(this.hash);
  }

  updated(changedValues: PropertyValues) {
    super.updated(changedValues);

    if (
      (changedValues.has("hash") &&
        changedValues.get("hash") !== undefined &&
        changedValues.get("hash")?.toString() !== this.hash?.toString()) ||
      changedValues.has("size")
    ) {
      const newHash =
        changedValues.get("hash") !== undefined
          ? changedValues.get("hash")
          : this.hash;
      const drawnCanvas = canvasCache.get(newHash).get(this.size);

      this._canvas.width = drawnCanvas.width;
      this._canvas.height = drawnCanvas.height;

      this._canvas.getContext("2d").drawImage(drawnCanvas, 0, 0);
    }
  }

  renderCanvas() {
    return html` <canvas
      id="canvas"
      width="1"
      height="1"
      class=${classMap({
        square: this.shape === "square",
        circle: this.shape === "circle",
      })}
    ></canvas>`;
  }

  render() {
    return html`<div
      @click=${() => this.copyHash()}
      style="${this.disableCopy ? "" : "cursor: pointer;"} flex-grow: 0"
    >
      <sl-tooltip
        id="tooltip"
        placement="top"
        .content=${this.justCopiedHash
          ? msg("Copied!")
          : `${this.strHash.substring(0, 6)}...`}
        .trigger=${this.disableTooltip || this.justCopiedHash
          ? "manual"
          : "hover focus"}
        hoist
      >
        ${this.renderCanvas()}
      </sl-tooltip>
    </div>`;
  }

  static get styles() {
    return css`
      :host {
        display: flex;
      }

      .square {
        border-radius: 0%;
      }
      .circle {
        border-radius: 50%;
      }
    `;
  }
}
