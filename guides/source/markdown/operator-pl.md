# Przygotowanie Pixela: przewodnik operatora

Przygotuj jeden zarejestrowany telefon Google Pixel albo jawnie wybraną flotę: GrapheneOS, profile użytkowników Androida, przypięte aplikacje i sprawdzone ustawienia. Pracuj w prywatnym projekcie i zachowuj razem plan, stan operacji oraz potwierdzenia przekazania.

**Zacznij tutaj:** ustal tożsamość telefonu, sprawdź politykę, zainstaluj system tylko po osobnym zatwierdzeniu, wykonaj konfigurację i etapy na telefonie, a następnie zakończ przygotowanie i przekaż urządzenie. Instalacja systemu usuwa dane. Samo zakończenie polecenia nie oznacza gotowości do przekazania.

Przykłady używają zainstalowanego polecenia `pxv`. Zastąp wszystkie symbole zastępcze. `--yes` potwierdza rzeczywisty przegląd lub kontrolę fizyczną; nie wykonuje tej kontroli.

Polecenia domyślnie pokazują czytelne podsumowania. Przy zapisywaniu danych dla skryptu dodaj `--json`; obsługiwane opcje pokazuje `pxv POLECENIE --help`. `--dry-run` jest przyjmowane przez polecenia z trybem podglądu. Operacje urządzenia przygotowują plan; polecenia aplikacji polityki pobierają i weryfikują pliki bez zapisu polityki i bez tworzenia planu urządzenia. Finalizacja, potwierdzenia i odzyskiwanie odrzucają tę opcję. Historia operacji jest stronicowana: `agent runs --json` zwraca `items` oraz `nextCursor`; niepusty kursor przekaż przez `--cursor` i powtarzaj do otrzymania wartości `null`.

## 1. Przygotuj komputer i projekt

Użyj sprawdzonego archiwum przenośnego lub pakietu dla Linuksa x86_64. Archiwum przenośne i pakiet Debian zawierają Node oraz natywny proces nadzorujący; narzędzia Androida i uprawnienia USB wymagają osobnej konfiguracji. Pracuj na zwykłym koncie operatora.

```sh
pxv version
pxv host doctor
pxv host adb-start --yes
```

Diagnostyka nie uruchamia ADB. Usuń problemy z narzędziami, uprawnieniami i natywnym środowiskiem przed podłączeniem telefonu użytkownika. W repozytorium po zbudowaniu używa się `pnpm pxv`; dokładne wersje i kontrole opisują [zależności komputera](../../../docs/operators/host-setup.md).

Inicjalizacja projektu wymaga kompletu przypięć aplikacji. Jeśli polityka zawiera
tylko deklaracje źródeł, najpierw [uzupełnij przypięcia w osobnym pliku](../../../docs/operators/policy-reference.md#resolve-a-source-draft-before-project-initialization)
z jawnymi wartościami SDK/ABI, a następnie użyj tego pliku poniżej.

Utwórz nowy projekt poza repozytorium kodu i zasobów. Wszystkie telefony dostępne z tego komputera powinny korzystać ze wspólnego obszaru kontroli operatora.

```sh
P='/bezwzgledna/prywatna/sciezka/projektu'
ASSET='telefon-01'
OPERATOR='Imię operatora'
pxv project init --path "$P" --policy /bezwzgledna/sciezka/sprawdzonej-polityki.json
```

Wykonuj spójne kopie prywatnego stanu projektu i ewidencji urządzeń. Dane do odblokowania kopii przechowuj osobno. Nie twórz telefonu we flocie przez kopiowanie bazy, zatwierdzeń ani danych uwierzytelniających innego urządzenia.

## 2. Określ system, profile i aplikacje

Sprawdź politykę przed rejestracją i wykonaniem operacji. Dołączony zestaw pięciu profili jest szkieletem: nie zapewnia zatwierdzonych aplikacji, działających kont VPN ani kwalifikacji wdrożenia.

Zdefiniuj katalog `apps` raz, a w listach `apps` profili wskazuj jego identyfikatory. Przypnij identyfikator pakietu, kod wersji, SHA-256 pliku APK, SHA-256 podpisującego i zatwierdzone źródło. Wersje pakietów Androida są wspólne dla użytkowników; profile nie mogą instalować sprzecznych wersji niezależnie.

Zarządzana aplikacja musi mieć jeden samodzielny plik APK. PXV sprawdza pakiet,
wersję, podpisującego i SHA-256 na tych samych pobranych bajtach. Inna zawartość
przy tej samej wersji i podpisie wymaga zatwierdzonej reinstalacji z uwzględnieniem
wpływu na innych użytkowników. Instalacja dzielona wymaga jawnej konserwacji;
PXV nigdy nie usuwa jej automatycznie. Brak lub niezgodność aktualnych skrótów
blokuje akceptację i finalizację. Starsze autentyczne przekazania pozostają dowodem
historycznym bez dopisywania skrótów.

### Uzupełnij i aktualizuj przypięcia aplikacji

`policy resolve-apps` uzupełnia brakujące kody wersji, skróty APK i odciski
certyfikatów podpisujących. Obsługuje `direct`, oficjalne F-Droid
(`fdroid`/`fdroidcl`), własne `fdroid-repository`, starsze odwołania do repozytoriów
lub URL oraz lokalne APK. Podane przypięcia pozostają wymaganiami. Przed inicjalizacją
projektu z polityki zawierającej tylko źródła sprawdź wynik i zapisz osobny plik:

```sh
pxv policy resolve-apps --policy /prywatna/sciezka/polityka.zrodla.json \
  --sdk 36 --abi arm64-v8a --output /prywatna/sciezka/polityka.przypieta.json --dry-run
pxv policy resolve-apps --policy /prywatna/sciezka/polityka.zrodla.json \
  --sdk 36 --abi arm64-v8a --output /prywatna/sciezka/polityka.przypieta.json
```

Podaj SDK i ABI docelowego Androida zamiast zakładać wartości z przykładu.
Sprawdź nowo odczytany certyfikat APK: pierwszy certyfikat z bezpośredniego pobrania
nie potwierdza niezależnie tożsamości wydawcy. Certyfikat własnego repozytorium musi
być już zaufany. Przypięty wynik przekaż do `project init`. W istniejącym projekcie
użyj `--project-root` zamiast `--policy`, aby uzupełnić skonfigurowaną politykę.

Do aktualizacji istniejących przypięć z zaufanych repozytoriów F-Droid służy
`policy update-apps`. Po rejestracji telefonu z rozdziału 3 i uruchomieniu jego
własnej usługi ADB:

```sh
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb --dry-run
pxv policy update-apps --project-root "$P" --asset "$ASSET" --transport usb
```

Polecenie zapisujące pokazuje nowy przegląd do potwierdzenia. Zachowuje certyfikat
podpisującego i nie obniża wersji. Sprawdź każdy pominięty wpis: pobrania wydawcy i
lokalne APK bez zaufanego powiązania z repozytorium wymagają osobnego przeglądu
wydania. Uzupełnianie przypięć kończy się błędem, jeśli dowolna aplikacja, także
nieużywana w profilach, nie przejdzie weryfikacji.

Oba polecenia działają na komputerze operatora. Inspekcja APK wymaga `aapt` i
`apksigner`; repozytoria dodatkowo wymagają `fdroidcl` i Javy. Bez podłączonego
telefonu zastąp `--asset`/`--transport` parą `--sdk N --abi ABI[,ABI...]`;
źródła zdalne nadal wymagają sieci. Polecenia zapisują pliki polityki, nie zmieniają
telefonu i pozostawiają dotychczasową blokadę polityki. Po zapisie wykonaj poniższe
polecenia walidacji i blokady, sprawdź receptury przypisane do dokładnych wersji i
przejrzyj świeży plan urządzenia. Zobacz [dobór poleceń polityki](../../../docs/operators/policy-reference.md#choose-the-policy-command).

### Sprawdź pozostałe elementy polityki

Ustawienia Androida `global`, wspólne dla telefonu, umieść w `deviceSettings`. W `settings` profilu stosuj wpisy `secure` lub `system`. Świadomie ustal nazwy profili, uprawnienia, VPN i języki; nazwa właściciela musi odpowiadać zmierzonej nazwie. Wartości tajne nie należą do polityki ani tekstu receptur.

Dla różnych modeli mapa `os` wiąże dokładny codename Pixela z kompletem danych uwierzytelnionego obrazu GrapheneOS. Każdy model przeznaczony do instalacji wymaga własnego wpisu. Nie ma zgadywania ani obrazu zastępczego. Schemat opisuje [format polityki](../../../docs/operators/policy-reference.md).

```sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
pxv guide project --project-root "$P" --kind pixel --locale pl
```

Zgodna blokada polityki jest wymagana przed planowaniem i ponownie sprawdzana przed wykonaniem, odświeżeniem przeglądu, poświadczeniem i finalizacją. `policy validate` podaje `policyLockStatus`: `current`, `missing`, `stale` lub `invalid`. Poprawną politykę można zweryfikować przed zablokowaniem. Jawnie odnów blokadę także po aktualizacji programu oraz zmianach polityki, konfiguracji lub rozszerzeń. Inspekcja, anulowanie, odzyskiwanie ze sprzątaniem, zapisy offline i potwierdzanie odbioru pozostają dostępne.

Przed nowym planem wybierz politykę w `pxv.project.json`, zweryfikuj i jawnie zablokuj ją.

Brak plików rozszerzenia nie blokuje historii, odbioru, zdarzeń cyklu życia ani kontrolowanego odzyskiwania. Po finalizacji odbiór potwierdza pierwotną, zweryfikowaną wersję przekazania mimo zmian programu lub polityki; zdarzenie cyklu życia unieważnia możliwość tego odbioru.

## 3. Zarejestruj dokładnie wskazany telefon

Porównaj fizyczną etykietę, numer seryjny sprzętu, model i codename. W miarę możliwości odłącz inne telefony. Pierwsza rejestracja odbywa się przez USB. Gdy działa Android, tymczasowo włącz debugowanie USB i zatwierdź ten komputer na telefonie.

```sh
pxv inventory enroll --project-root "$P" --asset "$ASSET" \
  --serial ODCZYTANY_NUMER --model 'RZECZYWISTY MODEL PIXELA' --codename WLASCIWY_CODENAME
pxv inventory list --project-root "$P"
pxv device inspect --project-root "$P" --asset "$ASSET" --transport usb
```

Jeżeli telefon jest już w fastboot, dodaj do rejestracji `--mode fastboot`; sprawdzane są dokładny numer i zgłoszony codename. Pomiń polecenie ADB `device inspect` do czasu uruchomienia Androida i autoryzacji debugowania. Rejestracja nie zezwala na usunięcie danych. Telefon zastępczy wymaga własnej, sprawdzonej tożsamości w ewidencji.

Jeden telefon wybieraj przez `--asset ID`. Flota wymaga jawnego `--group GRUPA` albo `--all`; selektorów nie można łączyć. Urządzenie o identyfikatorze `all` nadal wybiera się przez `--asset all`.

## 4. Zainstaluj GrapheneOS w osobnym etapie destrukcyjnym

Pomiń ten etap, jeżeli właściwy system jest już zainstalowany i zweryfikowany. Przed instalacją uzgodnij zakres usunięcia danych, zachowaj obsługiwane kopie danych telefonu i potwierdź zgodę na wymazanie wskazanego urządzenia. Przeczytaj [procedury testów, kopii i odzyskiwania](../../../docs/operators/recovery-and-maintenance.md).

Wykonaj [oficjalne przygotowanie GrapheneOS](https://grapheneos.org/install/cli#enabling-oem-unlocking), w tym włączenie odblokowania OEM w działającym systemie, gdy jest wymagane. Ręcznie przejdź do **Fastboot Mode** bootloadera, porównaj tożsamość fizycznego telefonu i pozostaw go w tym trybie. PXV sprawdza dokładny cel fastboot; nie przełącza sam telefonu z ADB. Polecenia odblokowania i ponownego zablokowania pozostaw sprawdzonej operacji PXV.

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Sprawdź zwrócone `planId`, `reviewSummary` i czas ważności. Porównaj fizyczny telefon, codename, wydanie, tożsamość obrazu i podpisu oraz zakres usuwania danych. Aby wykonać instalację interaktywnie, uruchom:

```sh
pxv device install-os --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
pxv agent status --project-root "$P" --run OS_RUN_ID --after 0
```

Polecenie przygotowuje nowy plan i wymaga ponownego przeglądu przed potwierdzeniem; wcześniejszy dry-run nie udziela zgody. Zachowaj zwrócony identyfikator operacji dla `agent status`. Obsłuż fizyczne potwierdzenia odblokowania i ponownego zablokowania bootloadera. Nie odłączaj telefonu ani nie przerywaj celowo instalacji. Sprawdź instalację i zablokowany bootloader zgodnie z wynikami kontroli i komunikatami telefonu. Kontener Docker w trybie host-ADB nie instaluje systemu; wymagane jest bezpośrednie USB.

Operacja systemowa zatrzymuje się na konfigurację i ponowne potwierdzenie urządzenia. Dokończ konfigurację telefonu, ponownie autoryzuj debugowanie USB, potwierdź istniejącą rejestrację przez `device inspect` i przygotuj **nowy plan konfiguracji**. Nie uruchamiaj ponownego flashowania, aby przejść dalej, ani nie rejestruj tego samego telefonu drugi raz. Powiązania rejestru objęte flashowaniem stają się nieaktualne także po niepowodzeniu instalacji.

## 5. Przygotuj, sprawdź i zatwierdź konfigurację

Konfiguracja obejmuje profile, aplikacje, ustawienia, uprawnienia i zadeklarowane etapy konfiguracji aplikacji. Nie dołącza automatycznie instalacji systemu. `create-users` i `deploy` służą do świadomie węższego zakresu.

```sh
pxv device provision --project-root "$P" --asset "$ASSET" --transport usb --dry-run
```

Sprawdź wszystkie czynności, skutki dla wspólnych pakietów, telefon, trwałe tożsamości użytkowników Androida, etapy ręczne i czas ważności. Uruchom konfigurację interaktywnie i przeczytaj jej nowy plan przed potwierdzeniem:

```sh
pxv device provision --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR"
pxv agent status --project-root "$P" --run RUN_ID --after 0
```

Zachowaj identyfikator operacji i sprawdź jej stan oraz `pauseReason`. Ręczny etap oznacza, że praca nie jest zakończona. Przy kolejnych odczytach podawaj ostatni kursor zdarzeń. Zatwierdzanie zachowanego planu w tle opisuje [automatyzacja](../../../docs/ai-agents/workflow-and-recovery.md), wraz z dokładnym zapisem pliku przeglądu. `device guided` pokazuje instrukcje z polityki i wykonuje zadanie po potwierdzeniu; `--dry-run` służy do wcześniejszego przeglądu.

Ustaw `scramblePinLayout: true` w profilu, który ma używać losowego układu cyfr głównego PIN-u, albo `false` dla zwykłego układu; pominięcie pola pozostawia ustawienie bez zarządzania. Jest stosowane przed inicjalizacją PIN-u i sprawdzane również przy kolejnej konfiguracji. Szablony flotowe włączają je w profilach z początkowym PIN-em. Odczyt zapisanej wartości wymaga prywatnego sprawdzenia wyglądu klawiatury na etapie `normal_credentials`; opcja nie konfiguruje losowania PIN-u drugiego składnika odcisku palca.

Opcjonalne początkowe dane blokady pochodzą z `secrets/credentials/ASSET.json`: dokumentu `schemaVersion: 1`, którego mapa `values` rozwiązuje odwołania do sekretów z polityki. Użyj własnego pliku `0600` i prywatnych katalogów; nie wpisuj wartości do poleceń ani notatek. Usuń deklaracje domyślne, jeżeli konfiguracja ma być ręczna. Wartości te inicjalizują profil bez istniejącej blokady; nie służą do zmiany hasła. Przyjęta inicjalizacja jest pomijana w kolejnych operacjach dla tej samej trwałej tożsamości użytkownika.

Przy automatycznej inicjalizacji przymusu `ownerCredentialRef` musi wskazywać **aktualny zwykły kod lub hasło właściciela**, zaktualizowane prywatnie po zmianie. Nigdy nie używaj istniejącego kodu przymusu do uwierzytelnienia. Nieobsługiwane polecenia lub istniejąca blokada wymagają inspekcji i nowego planu z konfiguracją ręczną. Przyjęcie polecenia nie dowodzi rzeczywistego odblokowania.

## 6. Wykonaj wskazane etapy na telefonie

Oczekująca operacja zwraca `pauseReason` i nazwę następnego etapu. Wykonaj wskazaną czynność we właściwym profilu. Konta, importy, MFA i zgody Androida konfiguruj prywatnie przed potwierdzeniem.

Konfiguracja aplikacji poprzedza weryfikację VPN. Zmieniona konfiguracja bez odpowiedniej recepty może najpierw zatrzymać się na `app_setup`, aby prywatnie skonfigurować konto i zgodę Androida. Następnie każdy profil zatrzymuje się na `vpn_settings`, także gdy zapisane ustawienia są zgodne lub VPN jest wyłączony. W podanym profilu otwórz ustawienia VPN Androida i ustaw lub sprawdź wskazaną aplikację, stale włączony VPN oraz blokowanie połączeń bez VPN. Zapisz `device attest --check vpn_settings --asset "$ASSET" --operator "$OPERATOR"` ze ścieżką projektu i wznów przebieg. Każdy profil wymaga osobnego potwierdzenia. Dowód ma zakres `operator-witnessed-settings`: jest potwierdzeniem operatora, a nie automatycznym pomiarem bieżącego egzekwowania VPN. Wymagane próby sieciowe pozostają oddzielne.

Stan VPN deklaruj wyłącznie w bloku `vpn` polityki. Usuń wpisy secure-setting dla
`always_on_vpn_app` i `always_on_vpn_lockdown`; duplikaty są odrzucane także przy
zgodnych wartościach. Potwierdzenie wymaga zachowanej czynności, przebiegu i audytu.
Odświeżenie zachowuje tylko uwierzytelnioną historię. Braki lub zmiany wymagają
inspekcji i nowego zatwierdzonego przygotowania; nie edytuj dowodów.

Receptury są przypisane do konkretnej kompilacji Androida oraz wersji i podpisującego aplikację. Nieobsługiwane ekrany i importy pozostają ręczne lub wspomagane. Bez zaakceptowanego adaptera wyboru pliku wykonaj cały import zatwierdzoną prywatną metodą; plik tymczasowy nie czeka na późniejsze wskazanie. Nie umieszczaj wrażliwej konfiguracji w publicznym tekście receptury.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check app_setup --operator "$OPERATOR"
pxv agent resume --project-root "$P" --run RUN_ID
```

Jeśli etap ma inną nazwę, zastąp `app_setup` właściwą. Przy `language:PROFIL` zmień język na telefonie i wznów operację; nie twórz potwierdzenia języka. Kolejność prywatna to sprawdzenie zwykłych blokad wszystkich profili, język docelowy, a następnie opcjonalny przymus. Obie wartości przymusu muszą różnić się od wszystkich rzeczywistych zwykłych danych blokady. Nigdy nie uruchamiaj wymazania w ramach testu.

Po wygaśnięciu przeglądu na celowym ręcznym punkcie kontrolnym `agent refresh --run RUN_ID` przygotowuje pozostałe czynności do nowego zatwierdzenia. Zapisz nowe dokładne podsumowanie i przekaż nowy plan do `agent execute`. Odświeżenie nie zatwierdza zmian ani nie odzyskuje niepewnej, przerwanej operacji.

Po konfiguracji atestacja może korzystać z wygasłego planu wykonania, jeśli pomiary mają najwyżej 15 minut, a stan telefonu nie zmienił się. Nieaktualne pomiary odbioru wymagają nowej konfiguracji po przeglądzie planu. Terminal Dockera przekazuje pytania i postęp na bieżąco; tryb JSON wymaga jawnego potwierdzenia nieinteraktywnego. Nakładka montuje wskazane pliki zewnętrzne i katalogi wynikowe, a bezpośrednie USB zachowuje dodatkowe grupy operatora. Instrukcja Dockera opisuje ponowne utworzenie usługi ADB i MCP uruchamiane bezpośrednio w kontenerze.

## 7. Sprawdź telefon i przekaż go odbiorcy

Gotowość receptur i prób sieci wymaga pełnych wyników, dokładnego pochodzenia i
poświadczeń z audytu. Brak lub sprzeczność punktu receptury blokuje wznowienie i
odświeżenie; PXV nie powtarza UI ani nie odtwarza dowodów. Zachowaj zapisy, sprawdź
aplikację i wykonaj wymagane odzyskiwanie przed nowym zatwierdzonym planem. Awaria
nie nadpisuje nowszych ani zakończonych zapisów; komunikat obejmuje oba błędy
operacji i zamykania magazynu.

Przed końcowym zatwierdzeniem możesz zapisać uzgodnione dane trzema opcjonalnymi poleceniami odczytu z rozdziału 9. Zakończ odczyt przed wyłączeniem debugowania.

Odczytaj aktualne wymagania i zapisany stan gotowości, a następnie wykonaj rzeczywiste kontrole:

```sh
pxv device report --project-root "$P" --asset "$ASSET"
pxv guide project --project-root "$P" --kind pixel --locale pl
```

Sprawdź trwałość po restarcie, rozdzielenie profili, aplikacje, uprawnienia i ustawienia, języki, oczekiwane działanie sieci i wymagane reprezentatywne odtworzenie danych. Pomocnik sieciowy bada własny UID i zatwierdzone punkty końcowe; nie potwierdza całego ruchu aplikacji. Zapisuj wyłącznie wykonane kontrole; potwierdzenie ręczne nie zastępuje sprzecznego pomiaru.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check WYMAGANA_KONTROLA --operator "$OPERATOR"
```

Wykonaj pozostałe wymagane kontrole, a następnie zapisz rzeczywistą akceptację odbiorcy przed świeżym `operator_signoff`. To potwierdzenie jest oddzielne od późniejszego zapisu przekazania telefonu. Podpis operatora i finalizacja korzystają ze świeżych pomiarów; zmieść się w oknie ważności wskazanym przez aplikację. Pozostawione pomocniki, nierozwiązane sprzątanie, rozbieżności i nieaktualna polityka lub kompilacja blokują gotowość.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check recipient_acceptance --operator "$OPERATOR"
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check operator_signoff --operator "$OPERATOR"
pxv device finalize --project-root "$P" --asset "$ASSET" \
  --transport usb --operator "$OPERATOR" --locale pl
```

`finalization-inspection` blokuje niedokończone wyłączenie debugowania. Sprawdź telefon i dowody, wykonaj wymagane odzyskiwanie, a następnie [konserwację oraz nowe przygotowanie i akceptację](../../../docs/operators/recovery-and-maintenance.md#recover-incomplete-finalization). Nie ponawiaj wyłączenia ani nie potwierdzaj odbioru. Błędy magazynu/dekodowania nie są zadaniami VPN. Odbiór uwierzytelnia cały pierwotny plan; zmienione lub niepełne dowody go blokują.

Zachowany zamiar blokuje też nowe planowanie, zatwierdzanie planu, odświeżanie,
wykonanie/wznowienie, poświadczenia, wkład rozszerzeń, Seedvault i kolektory po
zmianie polityki lub programu. Odnowienie blokady go nie usuwa. Inspekcja, historia,
anulowanie, typowane odzyskiwanie, rozłączenie i zapisy offline pozostają dostępne;
jawna konserwacja archiwizuje zamiar przed nowym zatwierdzonym przygotowaniem.

Każde nowe połączenie Seedvault wymaga aktualnego zatwierdzenia: przed pytaniem
o parowanie i ponownie po pytaniach. Dotyczy to też
`backup-only` i prób bez zmian. Brakującą, uszkodzoną lub nieaktualną blokadę
zweryfikuj i jawnie odnów; automat jej nie odnawia. Zmiana początkowej polityki
podczas pytań zatrzymuje `backup-only` nawet po odnowieniu blokady; zacznij od nowa.
Rozłączenie i odzyskiwanie wskazanej sesji pozostają dostępne. Historia połączeń
nie ma limitu 1000 zapisów; błąd uzgadniania zachowuje obowiązek sprzątania do
jawnego ponowienia, bez zmiany niezwiązanych sesji.

Po finalizacji fizycznie sprawdź, że **debugowanie USB i debugowanie bezprzewodowe są wyłączone**. Potwierdź, że bootloader jest zablokowany, a odblokowanie OEM wyłączone. Potwierdź, że odbiorca przejął telefon, i dopiero wtedy zapisz przekazanie:

```sh
pxv handoff accept --project-root "$P" --asset "$ASSET" \
  --recipient 'Imię odbiorcy' --debugging-off
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale pl --output /bezwzgledna/sciezka/przekazania
```

Odbiór kończy powiązany przebieg jako `completed`, bez instrukcji ponownej akceptacji; dokładne dowody korygują też starsze raporty. Historyczny odbiór nie wygasa. `measurement-freshness` oznacza niepoprawne, przyszłe lub starsze niż 15 minut pomiary, a `policy-lock` niezatwierdzoną politykę. Nie powtarzaj przygotowania wyłącznie dla odświeżenia pomiarów zakończonego przekazania.

Pakiet przekazania zawiera Markdown/HTML na podstawie zachowanego obrazu polityki. Sprawdź go przed udostępnieniem. Ogólne przewodniki PDF są instrukcją, a nie dowodem akceptacji telefonu.

Do każdego telefonu dołącz [kieszonkową instrukcję](quickstart-pl.md), przyjęty raport przekazania i zamkniętą [prywatną wkładkę z danymi dostępu](credentials-pl.md). Sprawdź zgodność identyfikatorów urządzenia. Wkładkę wypełniaj prywatnie poza źródłami instrukcji i zasobami wydania; w razie potrzeby skopiuj strony profili i kont. Prywatnie sprawdź zwykłe blokady, oznacz nieużywane pola oraz wartości początkowe lub ostatnio potwierdzone. Opcjonalne kody destrukcyjne umieść na osobno zamkniętej stronie. Wpisz rzeczywiste kontakty wsparcia i sposoby odzyskiwania oraz uzgodnij przechowywanie danych przez wsparcie. Po odbiorze użytkownik powinien przechowywać wkładkę oddzielnie od telefonu. Zobacz [pakowanie i drukowanie](../../../guides/README.md#pack-every-device).

Po aktualizacji lub archiwizacji raport zachowuje historię operacji. Gdy bieżąca ocena jest niedostępna, zwraca `ready: false`, `readinessStatus: unavailable` i przyczynę; nieprawidłowe dowody wymagają inspekcji. Nie powtarzaj zakończonego przekazania tylko dla odświeżenia pomiarów. Zakończenie operacji częściowej lub rozszerzenia nie jest dowodem odbioru telefonu.

## 8. Obsługuj flotę z osobnymi wynikami telefonów

Zarejestruj każdy fizyczny telefon oddzielnie. Sprawdź przypięty obraz każdego codename i plan każdego urządzenia. Zacznij od jednego telefonu, a równoległość zwiększaj świadomie; `--jobs` przyjmuje 1–8.

```sh
pxv fleet provision --project-root "$P" --group PARTIA --jobs 2 --dry-run
pxv fleet provision --project-root "$P" --group PARTIA --jobs 2 --operator "$OPERATOR"
```

Drugie polecenie przygotowuje nowe plany i prosi o potwierdzenie. Najpierw przeczytaj wyświetlony przegląd. Śledź każdą operację osobno; sukces jednego telefonu nie zalicza etapu innego ani nie usuwa jego błędu. Potwierdzenia, finalizacja, zmiany rejestru i odzyskiwanie dotyczą dokładnie jednego urządzenia. Instalację systemu we flocie przeprowadzaj w osobnym etapie, obsługując komunikaty każdego telefonu.

## 9. Zachowuj aktualne dane do uprawnionego wsparcia

Po prywatnej konfiguracji aplikacji, przed końcowym zatwierdzeniem i wyłączeniem
debugowania, możesz opcjonalnie uruchomić `device collect-oblivion`,
`device collect-sessionid` i `device collect-simcards`, każde z
`--project-root "$P" --asset "$ASSET"`. Najpierw zainicjuj rejestr. Odczyt aplikacji
obejmuje zarejestrowane profile, sprawdza podpisy i wymaga prywatnego odblokowania;
numery SIM są zapisywane raz dla urządzenia. Klucz Oblivion pochodzi z
`net.oblivion.wipe`, osobnej aplikacji od `org.bepass.oblivion` w pakietach startowych.
Otwarcie może włączyć wyzwalacze wymazania; potwierdź je dopiero po konfiguracji.
Nieczytelne wartości można wpisać w ukrytym monicie lub jawnie pominąć. Przejrzyj
wyniki i potwierdź zapis; `--yes` nie omija potwierdzeń. Zapis SIM zastępuje całą
listę numerów urządzenia. Polecenia nie tworzą zrzutów ekranu ani wiadomości.
Zmiana tożsamości lub błąd przywracania profilu blokuje zapis; zobacz
[odczyt i odzyskiwanie](../../../docs/operators/registry.md#opt-in-pre-handoff-collection).
Finalizacja nie wymaga tych opcjonalnych poleceń.

Lokalny szyfrowany rejestr łączy identyfikator zasobu, numer seryjny sprzętu i codename z trwałymi tożsamościami profili Androida. Może przechowywać numer telefonu i parę PIN/hasło przymusu urządzenia oraz PIN/hasło, klucz Oblivion, identyfikator komunikatora Session, login/hasło Proton VPN i opcjonalny numer telefonu każdego profilu. Współdzielone konta zapisuj jawnie; identyfikator Session nie jest identyfikatorem użytkownika Androida.

```sh
pxv registry init --project-root "$P"
pxv registry update --project-root "$P" --asset "$ASSET" \
  --file /prywatny/katalog/telefon.json --record-revision 0
pxv registry show --project-root "$P" --asset "$ASSET"
```

Rewizja zero służy wyłącznie do pierwszego wpisu; przy zmianie podaj rewizję z `show`. Aktualizacja zastępuje cały bieżący rekord telefonu i zachowuje wszystkie wcześniejsze rewizje w szyfrowanej historii. Stany to `initial`, `current`, `unknown` i `stale`; `current` oznacza ostatnie jawne potwierdzenie operatora, a nie automatyczny odczyt z telefonu. Po prywatnej zmianie danych uzgodnij aktualizację rejestru.

Odblokowanie odbywa się w ukrytym lokalnym monicie. Prywatne wejścia i wyniki wymagają własnego pliku `0600` w katalogu `0700`. `list`, `show` i `history` pomijają wartości; `reveal --asset ID --output NOWY_PRYWATNY_PLIK` celowo zapisuje tekst jawny. `rekey` zmienia hasło szyfrowania. `reconcile` jawnie przyjmuje przywróconą kopię lub przerwany zapis, dodając nieaktualne rewizje; następnie ponownie potwierdź aktualne dane. Najpierw przeczytaj [zasady rejestru, historii i odzyskiwania](../../../docs/operators/registry.md).

Prywatną wkładkę z zapisanymi danymi utworzysz poleceniem `pxv registry print-insert`, podając zasób, nowy prywatny plik PDF i lokalny Chromium. Zwarty eksport grupuje zwykłe dane według profilu, a dane destrukcyjne zaczyna na osobnym arkuszu A4 do wycięcia i złożenia. Typowy wpis mieści się na dwóch arkuszach; dłuższy zajmuje więcej bez skracania wartości ani zmniejszania ich pisma. Identyfikator pojawia się raz na arkuszu. Zapisane numery SIM z `device collect-simcards` są drukowane dla urządzenia; numery profili pozostają oddzielne. Brakujące obsługiwane pola mają podpisane miejsca do ręcznego uzupełnienia lub oznaczenia braku konfiguracji; osobne formularze odzyskiwania są pomijane. Zobacz [instrukcję eksportu rejestru](../../../docs/operators/guides-and-inserts.md#prefilled-private-phone-sized-insert).

Przebudowa poradników może utworzyć ten sam prywatny PDF przez `--private-insert-output PLIK --project-root KATALOG --asset ID --output-dir KATALOG --chromium ŚCIEŻKA`. Używa polityki projektu; prywatny wynik musi być poza wspólnym katalogiem poradników. Wspólne pliki zachowują puste formularze.

Aby wydrukować nazwę projektu lub inny kontakt do wsparcia, dodaj opcjonalne
`insertMetadata` do istniejącego `pxv.project.json`, na przykład
`"insertMetadata": { "projectName": "Przykładowa flota", "support": { "name": "Wsparcie urządzeń", "phone": "+48 123 456 789" } }`.
Nazwa projektu i obiekt wsparcia są niezależnie opcjonalne. Kontakt wymaga nazwy
oraz co najmniej adresu e-mail, strony HTTPS lub telefonu; zastępuje cały kontakt
produktu. Bez niego używany jest kontakt produktu. Wartości muszą być niepuste
i jednowierszowe. Edycja metadanych zmienia tożsamość polityki: zaktualizuj jej
blokadę i przygotuj nowe przeglądy operacji.

```sh
pxv policy lock --project-root "$P"
pxv guides rebuild --project-root "$P" --output-dir /prywatny/katalog-poradnikow --chromium /usr/bin/google-chrome
```

Powstaną puste wkładki EN/PL z metadanymi i polityką projektu, bez odblokowania
rejestru. Opcja `--html-only` może zastąpić wskazanie Chromium. Wybierz osobny
katalog wynikowy i pomiń `--policy`. Obie ścieżki eksportu prywatnego korzystają
z tych samych danych kontaktowych. Zobacz
[metadane wkładek projektu](../../../guides/README.md#project-names-and-support-contacts).

Flashowanie, tworzenie profilu, zapisy domyślnych blokad i zdarzenia cyklu życia unieważniają odpowiednie powiązania; stare wartości pozostają w historii. Polecenia rejestru są lokalne i offline; nie konfigurują telefonu ani nie dostarczają sekretów do konfiguracji. Użytkownik opisał klucz powiadomienia Oblivion, przypisany do profilu, jako wymazujący cały telefon; zachowanie nie ma kwalifikacji dla konkretnej aplikacji i kompilacji. Oddzielaj te klucze od przymusu GrapheneOS; nigdy nie umieszczaj prawdziwych kluczy w powiadomieniach, logach, zwykłych eksportach ani testach.

## 10. Obsłuż przerwanie i późniejszy serwis

Przy oczekiwaniu przeczytaj nazwę etapu. Po błędzie, anulowaniu, utracie hosta/kontenera lub stanie `needs-inspection` wstrzymaj kolejne zmiany i sprawdź telefon, zdarzenia operacji i należące do niej sprzątanie.

```sh
pxv agent status --project-root "$P" --run RUN_ID --after 0
pxv agent cancel --project-root "$P" --run RUN_ID
pxv device recover --project-root "$P" --asset "$ASSET"
pxv device recover --project-root "$P" --asset "$ASSET" \
  --run PIERWOTNY_OPERATION_ID --inspected
```

Anulowanie jest żądaniem, a nie dowodem sprzątnięcia. Użyj pierwotnego identyfikatora wskazanego w zachowanych danych odzyskiwania. Nie usuwaj bazy SQLite, blokad, znaczników ochronnych ani potwierdzeń, aby ponowić zadanie. Ponowne użycie ID lub nazwy użytkownika Androida nie zezwala na sprzątanie nowego użytkownika o innym numerze seryjnym. Nierozstrzygnięte sprzątanie natywne może wymagać restartu hosta i odzyskiwania po inspekcji.

Zapisz właściwe zdarzenie przez `lifecycle maintenance|policy-change|loss|retirement --asset ID --operator NAME --note TEXT`. Notatki nie zawierają sekretów. Zdarzenia unieważniają wcześniejsze potwierdzenie przekazania; nowe wdrożenie wymaga świeżego przeglądu i akceptacji. Używaj `--erased` dopiero po rzeczywistym potwierdzeniu usunięcia danych.

## Próba offline i dokumentacja

```sh
pxv project init --path /prywatna/sciezka/proba-offline --policy /sciezka/polityki-syntetycznej.json
pxv policy validate --project-root /prywatna/sciezka/proba-offline
pxv guide project --project-root /prywatna/sciezka/proba-offline --kind pixel --locale pl
```

Użyj nowego projektu i polityki syntetycznej; inicjalizacja zapisuje blokadę. Próba kwalifikuje tylko hosta; flashowanie, UI, VPN, odtwarzanie i odbiór wymagają testu fizycznego dla danej wersji. Community wyłącza rozszerzenia i Seedvault; ręczną kopię/odtwarzanie sprawdź osobno. Zobacz [polecenia](../../../docs/operators/command-reference.md), [automatyzację/MCP](../../../docs/ai-agents/workflow-and-recovery.md), [Docker](../../../docs/operators/host-setup.md), [bezpieczeństwo](../../../SECURITY.md) i [weryfikację](../../../docs/operators/acceptance.md).
