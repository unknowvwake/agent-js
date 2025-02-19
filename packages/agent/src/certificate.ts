import * as cbor from './cbor';
import { AgentError } from './errors';
import { hash } from './request_id';
import { bufEquals, concat, fromHex, toHex } from './utils/buffer';
import { Principal } from '@dfinity/principal';
import * as bls from './utils/bls';
import { decodeTime } from './utils/leb';
import { MANAGEMENT_CANISTER_ID } from './agent';

/**
 * A certificate may fail verification with respect to the provided public key
 */
export class CertificateVerificationError extends AgentError {
  constructor(reason: string) {
    super(`Invalid certificate: ${reason}`);
  }
}

export interface Cert {
  tree: HashTree;
  signature: ArrayBuffer;
  delegation?: Delegation;
}

export enum NodeType {
  Empty = 0,
  Fork = 1,
  Labeled = 2,
  Leaf = 3,
  Pruned = 4,
}

export type NodeLabel = ArrayBuffer | Uint8Array;

export type HashTree =
  | [NodeType.Empty]
  | [NodeType.Fork, HashTree, HashTree]
  | [NodeType.Labeled, NodeLabel, HashTree]
  | [NodeType.Leaf, NodeLabel]
  | [NodeType.Pruned, NodeLabel];

/**
 * Make a human readable string out of a hash tree.
 * @param tree
 */
export function hashTreeToString(tree: HashTree): string {
  const indent = (s: string) =>
    s
      .split('\n')
      .map(x => '  ' + x)
      .join('\n');
  function labelToString(label: ArrayBuffer): string {
    const decoder = new TextDecoder(undefined, { fatal: true });
    try {
      return JSON.stringify(decoder.decode(label));
    } catch (e) {
      return `data(...${label.byteLength} bytes)`;
    }
  }

  switch (tree[0]) {
    case NodeType.Empty:
      return '()';
    case NodeType.Fork: {
      if (tree[1] instanceof Array && tree[2] instanceof ArrayBuffer) {
        const left = hashTreeToString(tree[1]);
        const right = hashTreeToString(tree[2]);
        return `sub(\n left:\n${indent(left)}\n---\n right:\n${indent(right)}\n)`;
      } else {
        throw new Error('Invalid tree structure for fork');
      }
    }
    case NodeType.Labeled: {
      if (tree[1] instanceof ArrayBuffer && tree[2] instanceof ArrayBuffer) {
        const label = labelToString(tree[1]);
        const sub = hashTreeToString(tree[2]);
        return `label(\n label:\n${indent(label)}\n sub:\n${indent(sub)}\n)`;
      } else {
        throw new Error('Invalid tree structure for labeled');
      }
    }
    case NodeType.Leaf: {
      if (!tree[1]) {
        throw new Error('Invalid tree structure for leaf');
      } else if (Array.isArray(tree[1])) {
        return JSON.stringify(tree[1]);
      }
      return `leaf(...${tree[1].byteLength} bytes)`;
    }
    case NodeType.Pruned: {
      if (!tree[1]) {
        throw new Error('Invalid tree structure for pruned');
      } else if (Array.isArray(tree[1])) {
        return JSON.stringify(tree[1]);
      }

      return `pruned(${toHex(new Uint8Array(tree[1]))}`;
    }
    default: {
      return `unknown(${JSON.stringify(tree[0])})`;
    }
  }
}

interface Delegation extends Record<string, unknown> {
  subnet_id: ArrayBuffer;
  certificate: ArrayBuffer;
}

function isBufferGreaterThan(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const a8 = new Uint8Array(a);
  const b8 = new Uint8Array(b);
  for (let i = 0; i < a8.length; i++) {
    if (a8[i] > b8[i]) {
      return true;
    }
  }
  return false;
}

type VerifyFunc = (pk: Uint8Array, sig: Uint8Array, msg: Uint8Array) => Promise<boolean> | boolean;

export interface CreateCertificateOptions {
  /**
   * The bytes encoding the certificate to be verified
   */
  certificate: ArrayBuffer;
  /**
   * The root key against which to verify the certificate
   * (normally, the root key of the IC main network)
   */
  rootKey: ArrayBuffer;
  /**
   * The effective canister ID of the request when verifying a response, or
   * the signing canister ID when verifying a certified variable.
   */
  canisterId: Principal;
  /**
   * BLS Verification strategy. Default strategy uses bls12_381 from @noble/curves
   */
  blsVerify?: VerifyFunc;

  /**
   * The maximum age of the certificate in minutes. Default is 5 minutes.
   * @default 5
   * This is used to verify the time the certificate was signed, particularly for validating Delegation certificates, which can live for longer than the default window of +/- 5 minutes. If the certificate is
   * older than the specified age, it will fail verification.
   */
  maxAgeInMinutes?: number;

  /**
   * Overrides the maxAgeInMinutes setting and skips comparing the client's time against the certificate. Used for scenarios where the machine's clock is known to be out of sync, or for inspecting expired certificates.
   */
  disableTimeVerification?: boolean;
}

export class Certificate {
  public cert: Cert;
  #disableTimeVerification: boolean = false;

  /**
   * Create a new instance of a certificate, automatically verifying it. Throws a
   * CertificateVerificationError if the certificate cannot be verified.
   * @constructs  Certificate
   * @param {CreateCertificateOptions} options {@link CreateCertificateOptions}
   * @param {ArrayBuffer} options.certificate The bytes of the certificate
   * @param {ArrayBuffer} options.rootKey The root key to verify against
   * @param {Principal} options.canisterId The effective or signing canister ID
   * @param {number} options.maxAgeInMinutes The maximum age of the certificate in minutes. Default is 5 minutes.
   * @throws {CertificateVerificationError}
   */
  public static async create(options: CreateCertificateOptions): Promise<Certificate> {
    const cert = Certificate.createUnverified(options);

    await cert.verify();
    return cert;
  }

  private static createUnverified(options: CreateCertificateOptions): Certificate {
    let blsVerify = options.blsVerify;
    if (!blsVerify) {
      blsVerify = bls.blsVerify;
    }
    return new Certificate(
      options.certificate,
      options.rootKey,
      options.canisterId,
      blsVerify,
      options.maxAgeInMinutes,
      options.disableTimeVerification,
    );
  }

  private constructor(
    certificate: ArrayBuffer,
    private _rootKey: ArrayBuffer,
    private _canisterId: Principal,
    private _blsVerify: VerifyFunc,
    // Default to 5 minutes
    private _maxAgeInMinutes: number = 5,
    disableTimeVerification: boolean = false,
  ) {
    this.#disableTimeVerification = disableTimeVerification;
    this.cert = cbor.decode(new Uint8Array(certificate));
  }

  public lookup(path: Array<ArrayBuffer | string>): LookupResult {
    // constrain the type of the result, so that empty HashTree is undefined
    return lookup_path(path, this.cert.tree);
  }

  public lookup_label(label: ArrayBuffer): LookupResult {
    return this.lookup([label]);
  }

  private async verify(): Promise<void> {
    const rootHash = await reconstruct(this.cert.tree);
    const derKey = await this._checkDelegationAndGetKey(this.cert.delegation);
    const sig = this.cert.signature;
    const key = extractDER(derKey);
    const msg = concat(domain_sep('ic-state-root'), rootHash);
    let sigVer = false;

    const lookupTime = lookupResultToBuffer(this.lookup(['time']));
    if (!lookupTime) {
      // Should never happen - time is always present in IC certificates
      throw new CertificateVerificationError('Certificate does not contain a time');
    }

    // Certificate time verification checks
    if (!this.#disableTimeVerification) {
      const FIVE_MINUTES_IN_MSEC = 5 * 60 * 1000;
      const MAX_AGE_IN_MSEC = this._maxAgeInMinutes * 60 * 1000;
      const now = Date.now();
      const earliestCertificateTime = now - MAX_AGE_IN_MSEC;
      const fiveMinutesFromNow = now + FIVE_MINUTES_IN_MSEC;

      const certTime = decodeTime(lookupTime);

      if (certTime.getTime() < earliestCertificateTime) {
        throw new CertificateVerificationError(
          `Certificate is signed more than ${this._maxAgeInMinutes} minutes in the past. Certificate time: ` +
            certTime.toISOString() +
            ' Current time: ' +
            new Date(now).toISOString(),
        );
      } else if (certTime.getTime() > fiveMinutesFromNow) {
        throw new CertificateVerificationError(
          'Certificate is signed more than 5 minutes in the future. Certificate time: ' +
            certTime.toISOString() +
            ' Current time: ' +
            new Date(now).toISOString(),
        );
      }
    }

    try {
      sigVer = await this._blsVerify(new Uint8Array(key), new Uint8Array(sig), new Uint8Array(msg));
    } catch (err) {
      sigVer = false;
    }
    if (!sigVer) {
      throw new CertificateVerificationError('Signature verification failed');
    }
  }

  private async _checkDelegationAndGetKey(d?: Delegation): Promise<ArrayBuffer> {
    if (!d) {
      return this._rootKey;
    }

    const cert: Certificate = await Certificate.createUnverified({
      certificate: d.certificate,
      rootKey: this._rootKey,
      canisterId: this._canisterId,
      blsVerify: this._blsVerify,
      // Do not check max age for delegation certificates
      maxAgeInMinutes: Infinity,
    });

    if (cert.cert.delegation) {
      throw new CertificateVerificationError('Delegation certificates cannot be nested');
    }

    await cert.verify();

    if (this._canisterId.toString() !== MANAGEMENT_CANISTER_ID) {
      const canisterInRange = check_canister_ranges({
        canisterId: this._canisterId,
        subnetId: Principal.fromUint8Array(new Uint8Array(d.subnet_id)),
        tree: cert.cert.tree,
      });
      if (!canisterInRange) {
        throw new CertificateVerificationError(
          `Canister ${this._canisterId} not in range of delegations for subnet 0x${toHex(
            d.subnet_id,
          )}`,
        );
      }
    }
    const publicKeyLookup = lookupResultToBuffer(
      cert.lookup(['subnet', d.subnet_id, 'public_key']),
    );
    if (!publicKeyLookup) {
      throw new Error(`Could not find subnet key for subnet 0x${toHex(d.subnet_id)}`);
    }
    return publicKeyLookup;
  }
}

const DER_PREFIX = fromHex(
  '308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100',
);
const KEY_LENGTH = 96;

function extractDER(buf: ArrayBuffer): ArrayBuffer {
  const expectedLength = DER_PREFIX.byteLength + KEY_LENGTH;
  if (buf.byteLength !== expectedLength) {
    throw new TypeError(`BLS DER-encoded public key must be ${expectedLength} bytes long`);
  }
  const prefix = buf.slice(0, DER_PREFIX.byteLength);
  if (!bufEquals(prefix, DER_PREFIX)) {
    throw new TypeError(
      `BLS DER-encoded public key is invalid. Expect the following prefix: ${DER_PREFIX}, but get ${prefix}`,
    );
  }

  return buf.slice(DER_PREFIX.byteLength);
}

/**
 * utility function to constrain the type of a path
 * @param {ArrayBuffer | HashTree | undefined} result - the result of a lookup
 * @returns ArrayBuffer or Undefined
 */
export function lookupResultToBuffer(result: LookupResult): ArrayBuffer | undefined {
  if (result.status !== LookupStatus.Found) {
    return undefined;
  }

  if (result.value instanceof ArrayBuffer) {
    return result.value;
  }

  if (result.value instanceof Uint8Array) {
    return result.value.buffer;
  }

  return undefined;
}

/**
 * @param t
 */
export async function reconstruct(t: HashTree): Promise<ArrayBuffer> {
  switch (t[0]) {
    case NodeType.Empty:
      return hash(domain_sep('ic-hashtree-empty'));
    case NodeType.Pruned:
      return t[1] as ArrayBuffer;
    case NodeType.Leaf:
      return hash(concat(domain_sep('ic-hashtree-leaf'), t[1] as ArrayBuffer));
    case NodeType.Labeled:
      return hash(
        concat(
          domain_sep('ic-hashtree-labeled'),
          t[1] as ArrayBuffer,
          await reconstruct(t[2] as HashTree),
        ),
      );
    case NodeType.Fork:
      return hash(
        concat(
          domain_sep('ic-hashtree-fork'),
          await reconstruct(t[1] as HashTree),
          await reconstruct(t[2] as HashTree),
        ),
      );
    default:
      throw new Error('unreachable');
  }
}

function domain_sep(s: string): ArrayBuffer {
  const len = new Uint8Array([s.length]);
  const str = new TextEncoder().encode(s);
  return concat(len, str);
}

export enum LookupStatus {
  Unknown = 'unknown',
  Absent = 'absent',
  Found = 'found',
}

export interface LookupResultAbsent {
  status: LookupStatus.Absent;
}

export interface LookupResultUnknown {
  status: LookupStatus.Unknown;
}

export interface LookupResultFound {
  status: LookupStatus.Found;
  value: ArrayBuffer | HashTree;
}

export type LookupResult = LookupResultAbsent | LookupResultUnknown | LookupResultFound;

enum LabelLookupStatus {
  Less = 'less',
  Greater = 'greater',
}

interface LookupResultGreater {
  status: LabelLookupStatus.Greater;
}

interface LookupResultLess {
  status: LabelLookupStatus.Less;
}

type LabelLookupResult = LookupResult | LookupResultGreater | LookupResultLess;

export function lookup_path(path: Array<ArrayBuffer | string>, tree: HashTree): LookupResult {
  if (path.length === 0) {
    switch (tree[0]) {
      case NodeType.Leaf: {
        if (!tree[1]) {
          throw new Error('Invalid tree structure for leaf');
        }

        if (tree[1] instanceof ArrayBuffer) {
          return {
            status: LookupStatus.Found,
            value: tree[1],
          };
        }

        if (tree[1] instanceof Uint8Array) {
          return {
            status: LookupStatus.Found,
            value: tree[1].buffer,
          };
        }

        return {
          status: LookupStatus.Found,
          value: tree[1],
        };
      }

      default: {
        return {
          status: LookupStatus.Found,
          value: tree,
        };
      }
    }
  }

  const label = typeof path[0] === 'string' ? new TextEncoder().encode(path[0]) : path[0];
  const lookupResult = find_label(label, tree);

  switch (lookupResult.status) {
    case LookupStatus.Found: {
      return lookup_path(path.slice(1), lookupResult.value as HashTree);
    }

    case LabelLookupStatus.Greater:
    case LabelLookupStatus.Less: {
      return {
        status: LookupStatus.Absent,
      };
    }

    default: {
      return lookupResult;
    }
  }
}

/**
 * If the tree is a fork, flatten it into an array of trees
 * @param t - the tree to flatten
 * @returns HashTree[] - the flattened tree
 */
export function flatten_forks(t: HashTree): HashTree[] {
  switch (t[0]) {
    case NodeType.Empty:
      return [];
    case NodeType.Fork:
      return flatten_forks(t[1] as HashTree).concat(flatten_forks(t[2] as HashTree));
    default:
      return [t];
  }
}

export function find_label(label: ArrayBuffer, tree: HashTree): LabelLookupResult {
  switch (tree[0]) {
    // if we have a labelled node, compare the node's label to the one we are
    // looking for
    case NodeType.Labeled:
      // if the label we're searching for is greater than this node's label,
      // we need to keep searching
      if (isBufferGreaterThan(label, tree[1])) {
        return {
          status: LabelLookupStatus.Greater,
        };
      }

      // if the label we're searching for is equal this node's label, we can
      // stop searching and return the found node
      if (bufEquals(label, tree[1])) {
        return {
          status: LookupStatus.Found,
          value: tree[2],
        };
      }

      // if the label we're searching for is not greater than or equal to this
      // node's label, then it's less than this node's label, and we can stop
      // searching because we've looked too far
      return {
        status: LabelLookupStatus.Less,
      };

    // if we have a fork node, we need to search both sides, starting with the left
    case NodeType.Fork:
      // search in the left node
      const leftLookupResult = find_label(label, tree[1]);

      switch (leftLookupResult.status) {
        // if the label we're searching for is greater than the left node lookup,
        // we need to search the right node
        case LabelLookupStatus.Greater: {
          const rightLookupResult = find_label(label, tree[2]);

          // if the label we're searching for is less than the right node lookup,
          // then we can stop searching and say that the label is provably Absent
          if (rightLookupResult.status === LabelLookupStatus.Less) {
            return {
              status: LookupStatus.Absent,
            };
          }

          // if the label we're searching for is less than or equal to the right
          // node lookup, then we let the caller handle it
          return rightLookupResult;
        }

        // if the left node returns an uncertain result, we need to search the
        // right node
        case LookupStatus.Unknown: {
          let rightLookupResult = find_label(label, tree[2]);

          // if the label we're searching for is less than the right node lookup,
          // then we also need to return an uncertain result
          if (rightLookupResult.status === LabelLookupStatus.Less) {
            return {
              status: LookupStatus.Unknown,
            };
          }

          // if the label we're searching for is less than or equal to the right
          // node lookup, then we let the caller handle it
          return rightLookupResult;
        }

        // if the label we're searching for is not greater than the left node
        // lookup, or the result is not uncertain, we stop searching and return
        // whatever the result of the left node lookup was, which can be either
        // Found or Absent
        default: {
          return leftLookupResult;
        }
      }

    // if we encounter a Pruned node, we can't know for certain if the label
    // we're searching for is present or not
    case NodeType.Pruned:
      return {
        status: LookupStatus.Unknown,
      };

    // if the current node is Empty, or a Leaf, we can stop searching because
    // we know for sure that the label we're searching for is not present
    default:
      return {
        status: LookupStatus.Absent,
      };
  }
}

/**
 * Check if a canister falls within a range of canisters
 * @param canisterId Principal
 * @param ranges [Principal, Principal][]
 * @returns
 */
export function check_canister_ranges(params: {
  canisterId: Principal;
  subnetId: Principal;
  tree: HashTree;
}): boolean {
  const { canisterId, subnetId, tree } = params;
  const rangeLookup = lookup_path(['subnet', subnetId.toUint8Array(), 'canister_ranges'], tree);

  if (rangeLookup.status !== LookupStatus.Found || !(rangeLookup.value instanceof ArrayBuffer)) {
    throw new Error(`Could not find canister ranges for subnet ${subnetId}`);
  }

  const ranges_arr: Array<[Uint8Array, Uint8Array]> = cbor.decode(rangeLookup.value);
  const ranges: Array<[Principal, Principal]> = ranges_arr.map(v => [
    Principal.fromUint8Array(v[0]),
    Principal.fromUint8Array(v[1]),
  ]);

  const canisterInRange = ranges.some(r => r[0].ltEq(canisterId) && r[1].gtEq(canisterId));

  return canisterInRange;
}
