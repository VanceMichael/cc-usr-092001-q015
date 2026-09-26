// 受控业务错误：携带稳定错误码与 HTTP 状态，HTTP 层据此返回 4xx 而非 500。
export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}
