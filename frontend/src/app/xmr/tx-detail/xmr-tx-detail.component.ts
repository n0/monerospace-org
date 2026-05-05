import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';

/**
 * Public-only Monero tx detail. The data we surface is what's
 * mathematically observable from the chain alone; everything sensitive
 * (amounts, recipients, sender, real input / decoy boundary) is hidden
 * by RingCT and stays hidden in the default render.
 *
 * Three opt-in reveal flows give participants a way to disclose just
 * what they need to disclose:
 *
 *   1. "I received this tx"
 *      → recipient supplies sub-address + private view key.
 *      → Done in-browser via `monero-ts`. Decrypts which outputs
 *        landed at that address and their amounts.
 *
 *   2. "I sent this tx — verify payment to recipient"
 *      → sender supplies the OUTPUT of their wallet's `get_tx_proof`
 *        (a non-secret signature) plus the recipient address.
 *      → Server verifies; returns "verified — sent X XMR to that addr"
 *        or "invalid proof". No keys involved.
 *
 *   3. "I have the tx_secret_key"
 *      → sender supplies tx_secret_key (1-time per-tx random scalar)
 *        + recipient address. Used when they didn't pre-generate a
 *        proof signature.
 *      → Done in-browser. Reproduces what (2) verifies, locally.
 *
 * Keys never leave the browser. (2) is the only flow that talks to the
 * server, and only with non-secret data.
 *
 * For iter-12 the modals are functional placeholders that document the
 * flow but don't yet pull in monero-ts — that wasm dependency comes in
 * iter-13. Today they collect the inputs and explain "the actual
 * decryption runs locally; this iteration validates the UX shape."
 */

interface XmrPublicTx {
  status: 'mempool' | 'confirmed';
  hash: string;
  weight?: number;
  blob_size?: number;
  fee?: number;
  fee_per_byte?: number;
  receive_time?: number | null;
  block_height?: number;
  block_timestamp?: number;
  age_s?: number | null;
  confirmations?: number;
  num_inputs?: number;
  num_outputs?: number;
  ring_size?: number | null;
  ring_size_consistent?: boolean;
  ring_offsets_per_input?: number[][];
  key_images?: string[];
  has_view_tags?: boolean;
  rct_type?: number | null;
  unlock_time?: number;
  version?: number;
  double_spend_seen?: boolean;
}

type RevealKind = 'recipient' | 'tx-proof' | 'tx-secret-key';

interface RevealResult {
  kind: RevealKind;
  ok: boolean;
  message: string;
  payload?: { amount?: number; address?: string; outputIndex?: number };
}

@Component({
  selector: 'app-xmr-tx-detail',
  templateUrl: './xmr-tx-detail.component.html',
  styleUrls: ['./xmr-tx-detail.component.scss'],
  standalone: false,
})
export class XmrTxDetailComponent implements OnInit, OnDestroy {
  hash = '';
  loading = true;
  error: string | null = null;
  tx: XmrPublicTx | null = null;

  /** Map of reveal-kind → most recent result or pending state. */
  reveals: Partial<Record<RevealKind, RevealResult>> = {};
  activeModal: RevealKind | null = null;

  // Form fields. These never leave the component without explicit user
  // intent — and even with intent, only tx-proof crosses to the server.
  formAddress = '';
  formViewKey = '';
  formProofSignature = '';
  formTxSecretKey = '';

  private routeSub?: Subscription;

  constructor(
    private route: ActivatedRoute,
    private http: HttpClient,
  ) {}

  ngOnInit(): void {
    this.routeSub = this.route.params
      .pipe(
        switchMap((params) => {
          this.hash = params['id'] ?? params['hash'] ?? '';
          this.loading = true;
          this.error = null;
          return this.http
            .get<XmrPublicTx>(`/api/v1/tx/${this.hash}`)
            .pipe(catchError(() => of(null)));
        }),
      )
      .subscribe((tx) => {
        this.loading = false;
        if (!tx) {
          this.error = 'tx not found';
          return;
        }
        this.tx = tx;
      });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
  }

  /** Format atomic units → XMR with the canonical 12 decimals. */
  formatXmr(atomic: number): string {
    return (atomic / 1e12).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 12 });
  }

  /**
   * Bucket fee_per_byte into one of the four canonical Monero tiers so
   * the badge color matches the dashboard's mempool-wall ramp.
   * Tier thresholds derived from `get_fee_estimate` `fees` array
   * (slow / normal / fast / fastest).
   */
  feeTierOf(rate: number): 'slow' | 'normal' | 'fast' | 'fastest' {
    if (rate >= 4_000_000) return 'fastest';
    if (rate >= 320_000) return 'fast';
    if (rate >= 80_000) return 'normal';
    return 'slow';
  }

  rctTypeName(t: number | null | undefined): string {
    switch (t) {
      case 0: return 'none (pre-RCT)';
      case 1: return 'RCT v1 (full)';
      case 2: return 'RCT v2 (simple)';
      case 3: return 'RCT v3 (Bulletproof)';
      case 4: return 'RCT v4 (CLSAG)';
      case 5: return 'RCT v5 (Bulletproof+)';
      case 6: return 'RCT v6 (CLSAG + Bulletproof+)';
      default: return t === null || t === undefined ? '—' : `type ${t}`;
    }
  }

  openReveal(kind: RevealKind): void {
    this.activeModal = kind;
    // Don't pre-fill — keep it empty so the user sees what they're typing.
  }

  closeReveal(): void {
    this.activeModal = null;
    this.formAddress = '';
    this.formViewKey = '';
    this.formProofSignature = '';
    this.formTxSecretKey = '';
  }

  /**
   * Submit the active reveal. Behavior by kind:
   *
   *   - 'recipient' / 'tx-secret-key' : iter-12 placeholder — validates
   *     input shape, surfaces a "next iter loads monero-ts WASM and
   *     decrypts in-browser" message. NEVER sends keys to the server.
   *
   *   - 'tx-proof' : POSTs `/api/v1/tx/<hash>/verify-proof` with the
   *     recipient address + the proof signature. The server verifies
   *     and returns ok / not-ok + amount on success. Proof signatures
   *     are non-secret by design (the wallet generates them
   *     specifically for sharing).
   */
  submitReveal(): void {
    if (!this.activeModal) return;
    const kind = this.activeModal;
    if (kind === 'recipient') {
      if (!this.isProbablyMoneroAddress(this.formAddress) || !this.isHex64(this.formViewKey)) {
        this.reveals[kind] = { kind, ok: false, message: 'expected a Monero address + a 64-hex private view key' };
        return;
      }
      this.reveals[kind] = {
        kind,
        ok: true,
        message: 'Inputs accepted. Client-side decryption (monero-ts WASM) lands in iter-13 — your view key never left the browser, this UX iteration validates only the flow.',
      };
      this.closeReveal();
      return;
    }
    if (kind === 'tx-secret-key') {
      if (!this.isProbablyMoneroAddress(this.formAddress) || !this.isHex64(this.formTxSecretKey)) {
        this.reveals[kind] = { kind, ok: false, message: 'expected a recipient address + a 64-hex tx_secret_key' };
        return;
      }
      this.reveals[kind] = {
        kind,
        ok: true,
        message: 'Inputs accepted. Client-side verification (monero-ts WASM) lands in iter-13 — tx_secret_key never left the browser, this UX iteration validates only the flow.',
      };
      this.closeReveal();
      return;
    }
    if (kind === 'tx-proof') {
      if (!this.isProbablyMoneroAddress(this.formAddress) || this.formProofSignature.trim().length < 80) {
        this.reveals[kind] = { kind, ok: false, message: 'expected a Monero address + a tx_proof signature (~120 chars)' };
        return;
      }
      // tx_proof signatures are public, non-secret; safe to forward.
      this.http
        .post<{ ok: boolean; amount?: number; message?: string }>(`/api/v1/tx/${this.hash}/verify-proof`, {
          address: this.formAddress,
          signature: this.formProofSignature,
        })
        .pipe(catchError(() => of({ ok: false, amount: undefined, message: 'server error or endpoint not yet wired (iter-13)' })))
        .subscribe((resp: { ok: boolean; amount?: number; message?: string }) => {
          this.reveals[kind] = {
            kind,
            ok: !!resp.ok,
            message: resp.message ?? (resp.ok ? `verified — ${this.formatXmr(resp.amount ?? 0)} XMR sent to that address` : 'invalid proof'),
            payload: { amount: resp.amount, address: this.formAddress },
          };
        });
      this.closeReveal();
      return;
    }
  }

  private isHex64(s: string): boolean {
    return /^[a-f0-9]{64}$/i.test(s.trim());
  }

  // Lightweight check: Monero mainnet primary addresses start with '4'
  // (95 chars), integrated 106 chars, sub-address 95 chars starting with
  // '8'. We don't validate base58 here — the reveal form is permissive
  // and the actual decoder will reject bad input.
  private isProbablyMoneroAddress(s: string): boolean {
    return /^[48][0-9a-zA-Z]{94,105}$/.test(s.trim());
  }
}
