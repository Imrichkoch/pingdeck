# PingDeck

PingDeck je webová aplikácia na odosielanie upozornení z monitoringu, skriptov a domácej automatizácie do vlastných zariadení. Beží ako jedna inštancia pre jedného správcu. Prijímače fungujú cez štandard Web Push. Na iOS/iPadOS od verzie 16.4 otvor panel ako webovú aplikáciu pridanú zo Safari na plochu. Doručenie zabezpečujú služby Web Push dodávateľov prehliadačov.

## Spustenie

Potrebuješ Node.js 22.16+ a npm. Predvolená lokálna adresa je http://localhost:3417.

    npm ci
    npm run access -- setup
    npm start

Otvor /app, zadaj kód vypísaný príkazom a vytvor heslo správcu. V časti **Zariadenia** povoľ upozornenia. Zariadenie sa dá pomenovať a zaradiť do skupiny. V časti **Prehľad** odošli prvú správu.

### Nasadenie na VPS

1. Skopíruj .env.example do .env a nastav PUBLIC_ORIGIN na HTTPS adresu. Pri nasadení pod /pingdeck nastav BASE_PATH=/pingdeck. VAPID_SUBJECT nastav na verejný HTTPS origin inštancie alebo kontaktný e-mail v tvare mailto:admin@example.org.
2. Pri reverznom proxy nastav TRUST_PROXY=1 a prepisuj hlavičku X-Forwarded-For. Vzor konfigurácie je v deploy/nginx-location.conf. Pri nasadení v koreni vytvor location /, skopíruj direktívy zo vzoru a nechaj BASE_PATH prázdnu. Otestuj nginx -t a potom znovu načítaj konfiguráciu.
3. Spusť Docker Compose a vystav jednorazový kód do panelu.

       docker compose up -d --build
       docker compose exec app node access.mjs setup

Ak prevádzkuješ aj iné aplikácie, ktoré upravujú tretie strany, použitie vlastnej HTTPS subdomény umožní prehliadaču izolovať prístup k panelu podľa originu. Pri zmene domény sa zariadenia prihlásia k odberu znova. Compose sprístupňuje backend iba na 127.0.0.1. Kopírovanie archívu zdrojov do downloads/pingdeck-source.zip a reštart aplikácie sprístupnia stiahnutie zdrojov na landing page.

## Pripojenie zariadenia a jazyk

V paneli otvor Zariadenia a vyber prehliadač, Android alebo iPhone a iPad. Po povolení upozornení alebo spárovaní Androidu môžeš poslať skúšobnú správu iba na pripojené zariadenie. Pri bežnom odosielaní z panelu vždy vyber príjemcu. Keď vyberieš všetky zariadenia, panel si vypýta potvrdenie. Existujúce integrácie cez /api/v1/push používajú rovnaké parametre ako predtým.

Web vrátane schránky pre iPhone má prepínač SK / EN. Android má anglické a slovenské rozhranie podľa systému. Od Androidu 13 môžeš jazyk zmeniť aj priamo v nastaveniach aplikácie.

## Rozhranie

V **Integrácie** vytvor API kľúč pre monitorovací systém alebo skript a nastav PINGDECK_KEY. Lokálny príklad pre Bash.

    curl http://localhost:3417/api/v1/push \
      -H "Authorization: Bearer $PINGDECK_KEY" \
      -H 'Content-Type: application/json' \
      -d '{"title":"Záloha","message":"Hotovo!","group":"monitoring"}'

| Pole | Význam |
| --- | --- |
| message | Povinný text, najviac 600 znakov |
| title | Voliteľný nadpis, najviac 100 znakov |
| deviceId | ID z panelu Zariadenia |
| group | Názov skupiny, presná zhoda aj s veľkosťou písmen |
| url | Absolútna HTTP(S) adresa, ktorú otvorí kliknutie |
| ttl | Sekundy platnosti u poskytovateľa, 0 až 604800, predvolené 3600 |
| urgency | very-low, low, normal alebo high, predvolené normal |

Použi deviceId, group alebo vynechaj obidve polia pre odoslanie všetkým. Celkový zakódovaný obsah má limit 3500 bajtov. Stav HTTP 202 znamená, že aspoň jedna žiadosť bola prijatá službou Web Push alebo zaradená do frontu Androidu. JSON obsahuje id, status, accepted, failed a výsledky pre jednotlivé zariadenia v deliveries. Stav 422 znamená prázdny výber, 429 prekročený limit a 502 zlyhanie všetkých pokusov s výsledkami v JSON. Výsledok accepted označuje prijatie u poskytovateľa. Pri oneskorení alebo výpadku spojenia môže prehliadač upozornenie zobraziť neskôr. Ak bol odber zrušený alebo vypršal, inštancia odstráni zariadenie pri odpovedi 404 alebo 410. V prehľade sa zobrazí posledných 100 záznamov v rámci nastavenej doby uchovania.

## Prispôsobenie

| Súbor alebo nastavenie | Čo upravíš |
| --- | --- |
| branding.json | Názov, meta popis a predvolený nadpis upozornenia |
| public/site.css | Farebnosť cez CSS premenné, písmo a rozloženie |
| public/icon-192.png, public/icon-512.png, public/badge.png | Ikony PWA a Web Push |
| views/landing.html, views/app.html | Texty a rozloženie landing page a panelu |
| public/sw.js | Obsah a správanie upozornenia po kliknutí |
| HISTORY_DAYS, MAX_DEVICES, SENDS_PER_MINUTE | Doba uchovania, počet zariadení a limit požiadaviek |

Heslo správcu je uložené ako hash scrypt. Kľúče a relácie sú uložené ako SHA-256 hashe. SQLite uchováva aj VAPID kľúče, odbery a obsah histórie. Chráň databázu a zálohy ako citlivé údaje. Pri správe sa používajú oddelené kľúče pre odosielanie. Každú integráciu môžeš zrušiť samostatne.

## Údržba

V Docker Compose môžeš vytvoriť konzistentnú zálohu a skopírovať ju na hostiteľa.

    docker compose exec app node access.mjs backup /data/pingdeck-backup.sqlite
    docker compose cp app:/data/pingdeck-backup.sqlite ./pingdeck-backup.sqlite

Lokálny ekvivalent je npm run access -- backup cesta-k-zalohe.sqlite. Na obnovu prístupu použij príkaz docker compose exec app node access.mjs reset alebo npm run access -- reset. Ukončí existujúce relácie správcu a vypíše jednorazový kód. Pri obnove databázy zachovaj jej VAPID kľúče kvôli existujúcim odberom. Aplikácia funguje ako jeden proces nad jednou databázou.

## Mobilné aplikácie

Android 8+ má natívneho klienta v priečinku android. Na zostavenie vo Windows použi JDK 17 alebo 21, Android SDK Platform 36, Build Tools 36.1.0 a príkaz:

    ./android/build.ps1 -AndroidSdk D:/Android/Sdk -JdkHome H:/cesta/k/jdk

APK vznikne v work/android-build/pingdeck.apk. Rovnaký podpisovací kľúč v work/signing je potrebný pri ďalších vydaniach. Kľúč a heslo do verejného archívu nepatria. Kópiu APK umiestni v Compose do downloads/pingdeck.apk, potom reštartuj aplikáciu. Pre nasadenie bez Compose môžeš nastaviť ANDROID_APK na cestu k súboru.

V paneli v sekcii Zariadenia vytvor jednorazový párovací kód pre Android. Používateľ môže kód naskenovať priamo v aplikácii, otvoriť párovací HTTPS odkaz na telefóne alebo zadať kód ručne. Odkaz a QR obsahujú jednorazový kód vo fragmente URL a platia najviac 10 minút od vytvorenia. Telefón zobrazí adresu servera a vyžiada potvrdenie.

Odoslanie pozvánky e-mailom zapneš cez PAIR_SMTP_HOST, PAIR_SMTP_PORT (predvolene 465 s implicitným TLS), PAIR_SMTP_ADDRESS a PAIR_SMTP_PASSWORD. Použi oddelenú odosielaciu schránku. Priamy App Link pre raizenko.cloud je viazaný na podpis distribučného APK a cestu /pingdeck/android/pair. Pri zostavení pre iný host uprav AndroidManifest.xml, vygeneruj vlastný podpis a publikuj jeho SHA-256 odtlačok na /.well-known/assetlinks.json podľa príkladu v deploy. Skener a ručné párovanie fungujú aj s iným HTTPS serverom.

Prijímací kľúč povoľuje čítanie a potvrdenie správ iba pre spárovaný telefón. Android čaká na správy cez HTTPS pomocou služby s trvalým oznámením. Pozastavené správy ostanú vo fronte do nastavenej platnosti, najviac 100 na zariadenie. TTL 0 vyžaduje aktívne čakanie telefónu. Po reštarte telefónu môžeš príjem znova zapnúť v aplikácii. Na iPhone a iPade je klient dostupný ako webová aplikácia so schránkou správ na /iphone-app. Otvor ju v Safari a pridaj na plochu. Schránka uchováva posledných 100 doručených správ lokálne v prehliadači.

## Používateľské účty

Po nastavení PAIR_SMTP zapni verejnú registráciu nastavením REGISTRATION_ENABLED=1. Používateľ dostane jednorazové dočasné heslo s platnosťou 30 minút a pri aktivácii si nastaví vlastné heslo s aspoň 15 znakmi. Účty majú vlastné zariadenia, skupiny, API kľúče a históriu. Párovací e-mail možno poslať na overenú adresu účtu. Existujúci správca sa prihlasuje cez odkaz **Prístup správcu** a spravuje svoje doterajšie zariadenia a integrácie.

## E-mailový príjem

Vytvor vyhradenú IMAP schránku s dlhou náhodnou lokálnou časťou. V .env nastav MAIL_IMAP_HOST, MAIL_IMAP_ADDRESS a MAIL_IMAP_PASSWORD. Brána používa IMAPS s overením certifikátu. Prihlasovacie údaje patria do súkromného prostredia servera. Prijímacia adresa je dostupná po prihlásení v sekcii Integrácie. Každý, kto ju pozná, môže poslať upozornenie, preto ju zdieľaj iba s dôveryhodnými integráciami.

Predmet sa použije ako nadpis a text MIME správy ako telo. Predpona [skupina:monitoring] alebo [group:monitoring] v predmete zacieli skupinu. Bez predpony správa smeruje na všetky zariadenia. Brána priebežne spracúva vyhradený INBOX a odstraňuje spracované správy. Správy nad 256 KiB, staršie než dva dni a automatické odpovede vynecháva. Ak ešte nemáš pripojené zariadenia, hromadnú správu spracuje po ich pripojení, najneskôr do dvoch dní.

PingDeck je nezávislý projekt inšpirovaný pracovným postupom Pushsafer. Bricolage Grotesque a IBM Plex Mono sú dodávané cez balíky Fontsource pod licenciou SIL OFL.
