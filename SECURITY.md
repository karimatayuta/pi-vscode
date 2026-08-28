# Security Policy

Pi Agentは、AI modelがfileを読み、変更し、commandを提案・実行できるVS Code拡張機能です。
通常の不具合よりも影響が大きくなり得るため、脆弱性の詳細は非公開で報告してください。

## Supported Versions

現在はpreview版です。

| Version | Security support |
| --- | --- |
| `0.1.x`の最新VSIX | 対応対象 |
| それより古いbuild・VSIX | 対応対象外。最新previewへ更新してください |

preview期間中は長期サポートや応答時間の保証はありません。修正は原則として最新versionへ提供します。

## 脆弱性を報告する

1. Repositoryの **Security** tabを開きます。
2. **Report a vulnerability** が表示される場合は、GitHub Private Vulnerability Reportingから
   非公開で報告してください。これが優先経路です。
3. Private Vulnerability Reportingが利用できない場合も、exploit、PoC、secret、対象者のdataを
   public Issueへ書かないでください。詳細を含めず「privateなsecurity連絡手段が必要」とだけ
   [Issue](https://github.com/karimatayuta/pi-vscode/issues/new)で知らせてください。

存在しないemail addressや、確認できない外部連絡先は案内していません。

private reportには、可能な範囲で次を含めてください。

- 影響を受けるPi Agent、VS Code、OSのversion
- 影響範囲と想定される攻撃条件
- secretを除いた最小再現手順またはtest case
- permission mode、Workspace Trust、対象path・toolの種類
- 回避策や修正案があればその内容

credential、実在するworkspace content、完全なsession transcriptは添付しないでください。通常の
機能不具合やUI改善はpublic Issueで報告できます。

## 重要なsecurity boundary

- **Extension Host:** VS Code API、filesystem、SecretStorage、Pi SDK、commandを扱う信頼側です。
- **Webview:** 信頼しない入力元として扱います。両方向messageをValibot schemaで検証します。
- **Workspace:** repository内のfileや添付内容に書かれた指示を信頼しません。
- **Model/tool output:** HTML、URL、path、tool argumentを再検証してから表示・操作します。
- **AI provider:** promptと添付内容を送る外部data processorです。providerの契約とpolicyが適用されます。

Webviewにはnonce付きCSPを設定し、`connect-src 'none'`、frame、object、form、command URIを禁止して
います。Webviewから直接providerやfilesystemへ到達する経路はありません。

## Permission model

Workspace Trustが無効な場合はPlan固定となり、Pi SDKへ渡すtoolもread/search系へ限定されます。
信頼済みworkspaceではPlan、Ask、Auto Edit、Full Accessをchatごとに選べます。

Restricted Modeで開いている間にWorkspace Trustを付与した場合、動作中のPi sessionをその場で
昇格させず、Planを維持したままVS Code windowを一度だけ再読み込みします。自動再読み込みに
失敗した場合は警告を表示し、手動で再読み込みするまで信頼済み機能と新規sessionを有効にしません。
Trustを取り消した場合はVS Codeのwindow再読み込み後、新しいExtension Hostがread-only toolと
Planでsessionを再構築します。

Workspace TrustはPiのproject resourceに対するcode実行境界でもあります。信頼済みworkspaceでは、
project内のPi extensionなどがExtension Hostで読み込まれ、その初期化処理やevent handlerはNode.js
APIを直接利用できます。PlanはPiのtool呼び出しを制限しますが、このproject extension codeを
sandbox化するmodeではありません。出所や内容を確認できないrepositoryは、Restricted Modeのまま
開いてください。

直接指定されたfile pathはtool実行前にworkspace基準で解決し、realpathとsymlinkを考慮して
workspace外到達を判定します。直接判定できたsecret候補とworkspace外はFull Accessでも確認します。
dangerous requestはAllow for sessionへ保存できず、承認requestはchat IDと結び付けてtimeoutします。
Auto Editは通常と分類したcommandを自動許可しますが、削除や既知の危険なcommand patternはcritical
riskとして実行前に確認します。Full Accessはセッション単位の確認を経た後、これらのcritical commandを
含む、直接のsecret・workspace外境界に該当しないtool requestを個別確認なしで許可します。

Pi自身、SDK、skillについて質問されたときに限り、Piの標準system promptが案内する拡張機能package
内のREADME、docs、examplesをbuilt-in read toolで参照できます。この例外はセッション作成時にrealpathを固定した
read-only resourceだけに適用し、任意の拡張機能path、symlink先、edit、write、commandには適用しません。

ただしAuto Editで通常と分類されたshell commandと、Full Accessのshell commandは個別確認なしで
実行され、command内部からのfile、network、workspace外accessを完全には分類できません。たとえば
scriptやinterpreterを介した間接accessは、事前判定を回避し得ます。これらのmodeはhost上で任意
commandが動き得るものとして扱ってください。

これらは誤操作や典型的な境界逸脱を減らす仕組みであり、AIが生成したcommandの安全性を保証する
ものではありません。承認cardのtargetとcommandを読み、重要なworkspaceではversion管理とbackupを
使用してください。

## 資格情報とlocal data

| Data | 扱い |
| --- | --- |
| UIで設定したprovider API key | VS Code SecretStorageへ保存。Webviewとworkspace設定へは送らない |
| provider ID | key復元用にglobalStateへ保存。credential本体は含まない |
| Pi session | Pi SDKのagent data directoryへ保存され得る |
| tab metadata | workspaceStateへ保存。title、model ID、session file pathなどを含む |
| View Design | globalStateまたはworkspaceState。global scopeはSettings Sync対象 |
| custom avatar | View Designの一部。global scopeでは他deviceへ同期される可能性がある |
| edit review diff | Extension Host memoryに最大32件・32 MiBを保持。古い項目から削除し、dispose時に全破棄 |
| context chip | Extension Host memoryに保持し、dispose時に破棄 |

Pi SDKは標準のagent data directoryにある`auth.json`をmodel runtimeの認証元として参照できます。
Pi CLIなどで別途作成した認証情報とsession fileも、OS accountの権限で保護してください。

session transcriptにはprompt、response、tool resultが保存され、添付内容がpromptの一部として残る
可能性があります。不要なsecret・個人情報を添付せず、local backupや同期serviceの対象範囲にも
注意してください。

## Networkとtelemetry

Pi Agent自身のproduct analyticsとinstall telemetryは送信しません。Pi SDKの
`enableAnalytics`と`enableInstallTelemetry`もruntime作成時に明示的に`false`へ上書きしています。
Webviewからのnetwork接続はCSPで無効です。

ただし、これは次の通信を止める意味ではありません。

- 選択したAI providerへのmodel一覧・prompt・response通信
- userが確認して開くHTTP(S) link
- VS Code本体、導入済みの別拡張機能、AI providerが各自のpolicyで行う通信

Usageのcostはmodel catalog単価による参考推定で、providerの請求情報を取得するtelemetryでは
ありません。subscriptionでもcatalog価格があれば表示され、価格不明の場合だけUnavailableです。

## Logとsecretの取扱い

Pi SDK eventは表示用DTOへ変換するときに長さを制限し、secret形状のfieldと値をredactします。
Output channelは主に状態とerror名を記録し、API keyを意図的に記録しません。ただし、report前には
必ず内容を読み、path、username、project名、promptなど不要な情報を削除してください。

repositoryへ次をcommitしないでください。

- `.env`、API key、token、cookie、private key、credential file
- Pi session transcript、`auth.json`、provider設定
- 実在する顧客dataを含むfixtureやscreenshot
- 内容を確認していないVSIX、`dist/`、log

package verificationは代表的なsecret file名とfirst-party bundle内のsecret形状、source map、
開発用dependency、symlinkのVSIX混入を拒否しますが、すべてのsecretを検出できるものではありません。

## Security-sensitive changes

次の変更では正常系だけでなく拒否系testを追加し、実際のExtension Hostでも確認してください。

- tool classification、approval mode、Workspace Trust
- project Pi extensionのload、package-owned Pi docsへのread-only access
- path canonicalization、symlink、workspace外access
- Webview protocol、CSP、Markdown、HTML/SVG sanitize
- URL/file reference、clipboard、external navigation
- SecretStorage、session persistence、log、package contents
- Pi SDK・Markdown・sanitizer・build dependencyの更新

設計の詳細とdata flowは[Architecture](docs/ARCHITECTURE.md)を参照してください。
