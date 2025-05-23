import { msg } from '@lit/localize';
import { mdiPlus } from '@mdi/js';
import '@shoelace-style/shoelace/dist/components/avatar/avatar.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

import { FormField, FormFieldController } from '../form-field-controller.js';
import { wrapPathInSvg } from '../icon.js';
import { resizeAndExport } from '../image.js';
import { sharedStyles } from '../shared-styles.js';

@customElement('select-avatar')
export class SelectAvatar extends LitElement implements FormField {
	@property({ attribute: 'name' })
	name: string = 'avatar';

	@property()
	required: boolean = false;

	@property()
	shape: 'circle' | 'square' | 'rounded' = 'circle';

	@property()
	value: string | undefined;

	@property()
	disabled: boolean = false;

	@property()
	defaultValue: string | undefined;

	@property({ attribute: 'avatar-width' })
	avatarWidth: number = 300;

	@property({ attribute: 'avatar-height' })
	avatarHeight: number = 300;

	@property()
	label: string = msg('Avatar');

	@query('#avatar-file-picker')
	private _avatarFilePicker!: HTMLInputElement;

	@query('#error-input')
	private _errorInput!: HTMLInputElement;

	_controller = new FormFieldController(this);

	reportValidity() {
		const invalid = this.required && !this.value;
		if (invalid) {
			this._errorInput.setCustomValidity(msg('Avatar is required'));
			this._errorInput.reportValidity();
		}

		return !invalid;
	}

	reset() {
		this.value = this.defaultValue;
	}

	onAvatarUploaded() {
		const button = this.shadowRoot!.querySelector('sl-button');
		if (button) button.loading = true;
		if (this._avatarFilePicker.files && this._avatarFilePicker.files[0]) {
			const reader = new FileReader();
			reader.onload = e => {
				const img = new Image();
				img.crossOrigin = 'anonymous';
				img.onload = () => {
					this.value = resizeAndExport(
						img,
						this.avatarWidth,
						this.avatarHeight,
					);
					this._avatarFilePicker.value = '';

					this.dispatchEvent(
						new CustomEvent('avatar-selected', {
							composed: true,
							bubbles: true,
							detail: {
								avatar: this.value,
							},
						}),
					);
					button.loading = false;
				};
				img.src = e.target?.result as string;
			};
			reader.readAsDataURL(this._avatarFilePicker.files[0]);
		}
	}

	renderAvatar() {
		if (this.value)
			return html`
				<div
					class="column"
					style="align-items: center; height: 50px"
					@click=${() => {
						this.value = undefined;
					}}
				>
					<sl-tooltip .content=${msg('Clear')}>
						<sl-avatar
							image="${this.value}"
							alt="Avatar"
							.shape=${this.shape}
							initials=""
						></sl-avatar
					></sl-tooltip>
				</div>
			`;
		else
			return html` <div class="column" style="align-items: center;">
				<sl-button
					.disabled=${this.disabled}
					variant="default"
					size="large"
					circle
					@click=${() => this._avatarFilePicker.click()}
				>
					<sl-icon
						src="${wrapPathInSvg(mdiPlus)}"
						.label=${msg('Add avatar image')}
					></sl-icon>
				</sl-button>
			</div>`;
	}

	render() {
		return html`<input
				type="file"
				id="avatar-file-picker"
				style="display: none"
				@change=${this.onAvatarUploaded}
			/>
			<div class="column" style="position: relative; align-items: center">
				<input
					id="error-input"
					style="position: absolute; z-index: -1; left: 50%; top: 30px; height: 0; width: 0"
				/>
				${this.label !== ''
					? html`
							<span
								style="font-size: var(--sl-input-label-font-size-medium); margin-bottom: 4px; white-space: nowrap;"
								>${this.label}${this.required !== false ? ' *' : ''}</span
							>
						`
					: html``}
				${this.renderAvatar()}
			</div>`;
	}

	static styles = sharedStyles;
}
