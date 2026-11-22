# 图站和岸巡窗口

`GET /images/index` 给一批待取图、存储代、空间格标识和剩余取件次数。缩略图记录仍可见但大图可能返回 410；每次尝试大图可能消耗本批一次领取。即使两个观察单引用同一编号，存储代仍需一致。原图响应可读 ETag 和部分字节。
`GET /crossings/slots` 给过岸时间、可达区和被占情况。向 `POST /crossings/withdraw` 发送单号和旧凭据，202 只表示岸巡收到了撤回申请。撤回或出发状态只有后续 `GET /crossings/receipts` 能确认。槽位开放时间单位为按当天开始计的整分钟。图像空间与遮挡来源见资料格式。
演练 `fog` 是初始画面，`clear` 出现可补图和两条外部派单，`released` 是过岸回执更新后。

外部接口 cell 分别对应观测资料中的 east 和 west。图像证明一次采样周期，采样周期为一整分钟。c62 属于 C 的 east 观察窗；该图到达时，另一个岸巡可继续在 west。岗位运行中可向 /crossings/hold 提交 slot 和 cell。原 /media 只提供历史已存档的原图，原图服务的新目录以 /images/index 为准。
