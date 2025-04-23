import {
  AgentPubKey,
  AppClient,
  AppEvents,
  AppInfo,
  CallZomeRequest,
  CellId,
  CellType,
  ClonedCell,
  CreateCloneCellRequest,
  DisableCloneCellRequest,
  DisableCloneCellResponse,
  DumpNetworkMetricsRequest,
  DumpNetworkMetricsResponse,
  DumpNetworkStatsResponse,
  EnableCloneCellRequest,
  EnableCloneCellResponse,
  Signal,
  SignalCb,
  decodeHashFromBase64,
} from "@holochain/client";
import Emittery, { UnsubscribeFunction } from "emittery";

const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(() => r(null), ms);
  });

export class ZomeMock implements AppClient {
  emitter = new Emittery();

  constructor(
    protected roleName: string,
    protected zomeName: string,
    public installedAppId = "mock_installed_app_id",
    public myPubKey: AgentPubKey = decodeHashFromBase64(
      "uhCAk13OZ84d5HFum5PZYcl61kHHMfL2EJ4yNbHwSp4vn6QeOdFii",
    ),
    protected latency: number = 500,
  ) {}

  get cellId(): CellId {
    return [
      decodeHashFromBase64("uhCAk6oBoqygFqkDreZ0V0bH4R9cTN1OkcEG78OLxVptLWOI"),
      this.myPubKey,
    ];
  }

  async appInfo(): Promise<AppInfo> {
    return {
      installed_at: Date.now(),
      agent_pub_key: this.myPubKey,
      installed_app_id: this.installedAppId,
      status: {
        type: "running",
      },
      cell_info: {
        [this.roleName]: [
          {
            type: CellType.Provisioned,
            value: {
              cell_id: this.cellId,
              name: this.roleName,
              dna_modifiers: {
                network_seed: "",
                properties: undefined,
              },
            },
          },
        ],
      },
    };
  }

  createCloneCell(_args: CreateCloneCellRequest): Promise<ClonedCell> {
    throw new Error("Method not implemented.");
  }

  enableCloneCell(
    _args: EnableCloneCellRequest,
  ): Promise<EnableCloneCellResponse> {
    throw new Error("Method not implemented");
  }

  disableCloneCell(
    _args: DisableCloneCellRequest,
  ): Promise<DisableCloneCellResponse> {
    throw new Error("Method not implemented");
  }

  dumpNetworkMetrics(
    args: DumpNetworkMetricsRequest,
  ): Promise<DumpNetworkMetricsResponse> {
    throw new Error("Method not implemented");
  }
  dumpNetworkStats(): Promise<DumpNetworkStatsResponse> {
    throw new Error("Method not implemented");
  }

  async callZome(req: CallZomeRequest): Promise<any> {
    await sleep(this.latency);
    return (this as any)[req.fn_name](req.payload);
  }

  on<Name extends keyof AppEvents>(
    eventName: Name | readonly Name[],
    listener: SignalCb,
  ): UnsubscribeFunction {
    return this.emitter.on(eventName, listener);
  }

  protected emitSignal(payload: any) {
    this.emitter.emit("signal", {
      type: "app",
      value: {
        cell_id: this.cellId,
        zome_name: this.zomeName,
        payload,
      },
    } as Signal);
  }
}
