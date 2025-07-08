import * as restate from "@restatedev/restate-sdk/lambda";

const echo = async (_ctx: restate.Context, data: string) => {
  return data;
};

export const handler = restate
  .endpoint()
  .bind(
    restate.service({
      name: "Echo",
      handlers: { echo },
    }),
  )
  .handler();
