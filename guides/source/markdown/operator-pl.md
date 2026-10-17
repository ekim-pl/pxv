# Przygotowanie Pixela: przewodnik operatora

Przygotuj jeden zarejestrowany telefon Google Pixel albo jawnie wybraną flotę: GrapheneOS, profile użytkowników Androida, przypięte aplikacje i sprawdzone ustawienia. Pracuj w prywatnym projekcie i zachowuj razem plan, stan operacji oraz potwierdzenia przekazania.

**Zacznij tutaj:** ustal tożsamość telefonu, sprawdź politykę, zainstaluj system tylko po osobnym zatwierdzeniu, wykonaj konfigurację i etapy na telefonie, a następnie zakończ przygotowanie i przekaż urządzenie. Instalacja systemu usuwa dane. Samo zakończenie polecenia nie oznacza gotowości do przekazania.

Przykłady używają zainstalowanego polecenia `pxv`. Zastąp wszystkie symbole zastępcze. `--yes` potwierdza rzeczywisty przegląd lub kontrolę fizyczną; nie wykonuje tej kontroli.

## 1. Przygotuj komputer i projekt

Użyj sprawdzonego archiwum przenośnego lub pakietu dla Linuksa x86_64. Archiwum przenośne i pakiet Debian zawierają Node oraz natywny proces nadzorujący; narzędzia Androida i uprawnienia USB wymagają osobnej konfiguracji. Pracuj na zwykłym koncie operatora.

```sh
pxv version
pxv host doctor
pxv host adb-start --yes
```

Diagnostyka nie uruchamia ADB. Usuń problemy z narzędziami, uprawnieniami i natywnym środowiskiem przed podłączeniem telefonu użytkownika. W repozytorium po zbudowaniu używa się `pnpm pxv`; dokładne wersje i kontrole opisują [zależności komputera](../../../docs/HOST_DEPENDENCIES.md).

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

W polityce v2 definiuj katalog `apps` raz, a w listach `apps` profili wskazuj jego identyfikatory. Przypnij identyfikator pakietu, kod wersji, SHA-256 pliku APK, SHA-256 podpisującego i zatwierdzone źródło. Wersje pakietów Androida są wspólne dla użytkowników; profile nie mogą instalować sprzecznych wersji niezależnie.

Ustawienia Androida `global`, wspólne dla telefonu, umieść w `deviceSettings`. W `settings` profilu stosuj wpisy `secure` lub `system`. Świadomie ustal nazwy profili, uprawnienia, VPN i języki; nazwa właściciela musi odpowiadać zmierzonej nazwie. Wartości tajne nie należą do polityki ani tekstu receptur.

Dla różnych modeli mapa `os` wiąże dokładny codename Pixela z kompletem danych uwierzytelnionego obrazu GrapheneOS. Każdy model przeznaczony do instalacji wymaga własnego wpisu. Nie ma zgadywania ani obrazu zastępczego. Schemat i migrację opisuje [format polityki](../../../docs/POLICY_FORMAT.md).

```sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
pxv guide project --project-root "$P" --kind pixel --locale pl
```

Zmiana polityki wymaga nowej blokady wersji i nowego przeglądu. `policy convert --output NOWY_PLIK` zapisuje format v2 bez zmiany oryginału i bez aktywacji. Wybierz sprawdzony plik w `pxv.project.json`, zweryfikuj i zablokuj politykę przed przygotowaniem nowych planów.

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

Pomiń ten etap, jeżeli właściwy system jest już zainstalowany i zweryfikowany. Przed instalacją uzgodnij zakres usunięcia danych, zachowaj obsługiwane kopie danych telefonu i potwierdź zgodę na wymazanie wskazanego urządzenia. Przeczytaj [procedury testów, kopii i odzyskiwania](../../../docs/CANARY_BACKUP_RECOVERY.md).

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

Zachowaj identyfikator operacji i sprawdź jej stan oraz `pauseReason`. Ręczny etap oznacza, że praca nie jest zakończona. Przy kolejnych odczytach podawaj ostatni kursor zdarzeń. Zatwierdzanie zachowanego planu w tle opisuje [automatyzacja](../../../docs/AUTOMATION.md), wraz z dokładnym zapisem pliku przeglądu. `device guided` pokazuje instrukcje z polityki i wykonuje zadanie po potwierdzeniu; `--dry-run` służy do wcześniejszego przeglądu.

Opcjonalne początkowe dane blokady pochodzą z `secrets/credentials/ASSET.json`: dokumentu `schemaVersion: 1`, którego mapa `values` rozwiązuje odwołania do sekretów z polityki. Użyj własnego pliku `0600` i prywatnych katalogów; nie wpisuj wartości do poleceń ani notatek. Usuń deklaracje domyślne, jeżeli konfiguracja ma być ręczna. Wartości te inicjalizują profil bez istniejącej blokady; nie służą do zmiany hasła. Przyjęta inicjalizacja jest pomijana w kolejnych operacjach dla tej samej trwałej tożsamości użytkownika.

Przy automatycznej inicjalizacji przymusu `ownerCredentialRef` musi wskazywać **aktualny zwykły kod lub hasło właściciela**, zaktualizowane prywatnie po zmianie. Nigdy nie używaj istniejącego kodu przymusu do uwierzytelnienia. Nieobsługiwane polecenia lub istniejąca blokada wymagają inspekcji i nowego planu z konfiguracją ręczną. Przyjęcie polecenia nie dowodzi rzeczywistego odblokowania.

## 6. Wykonaj wskazane etapy na telefonie

Oczekująca operacja zwraca `pauseReason` i nazwę następnego etapu. Wykonaj wskazaną czynność we właściwym profilu. Konta, importy, MFA i zgody Androida konfiguruj prywatnie przed potwierdzeniem.

Konfiguracja aplikacji poprzedza wymuszenie VPN. Zmiana always-on lub blokady ruchu bez VPN, bez pasującej receptury, zatrzymuje się na `app_setup`: skonfiguruj VPN w tym profilu, zatwierdź zgodę Androida i sprawdź zamierzone połączenie przed wznowieniem. Osobne etapy profili wymagają osobnych, nowych potwierdzeń.

Receptury są przypisane do konkretnej kompilacji Androida oraz wersji i podpisującego aplikację. Nieobsługiwane ekrany i importy pozostają ręczne lub wspomagane. Bez zaakceptowanego adaptera wyboru pliku wykonaj cały import zatwierdzoną prywatną metodą; plik tymczasowy nie czeka na późniejsze wskazanie. Nie umieszczaj wrażliwej konfiguracji w publicznym tekście receptury.

```sh
pxv device attest --project-root "$P" --asset "$ASSET" \
  --check app_setup --operator "$OPERATOR"
pxv agent resume --project-root "$P" --run RUN_ID
```

Jeśli etap ma inną nazwę, zastąp `app_setup` właściwą. Przy `language:PROFIL` zmień język na telefonie i wznów operację; nie twórz potwierdzenia języka. Kolejność prywatna to sprawdzenie zwykłych blokad wszystkich profili, język docelowy, a następnie opcjonalny przymus. Obie wartości przymusu muszą różnić się od wszystkich rzeczywistych zwykłych danych blokady. Nigdy nie uruchamiaj wymazania w ramach testu.

Po wygaśnięciu przeglądu `agent refresh --run RUN_ID` przygotowuje pozostałe czynności do nowego zatwierdzenia. Zapisz nowe dokładne podsumowanie i przekaż nowy plan do `agent execute`. Odświeżenie nie zatwierdza zmian ani nie odzyskuje niepewnej, przerwanej operacji.

## 7. Sprawdź telefon i przekaż go odbiorcy

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

Po finalizacji fizycznie sprawdź, że **debugowanie USB i debugowanie bezprzewodowe są wyłączone**. Potwierdź, że bootloader jest zablokowany, a odblokowanie OEM wyłączone. Potwierdź, że odbiorca przejął telefon, i dopiero wtedy zapisz przekazanie:

```sh
pxv handoff accept --project-root "$P" --asset "$ASSET" \
  --recipient 'Imię odbiorcy' --debugging-off
pxv handoff export --project-root "$P" --asset "$ASSET" \
  --locale pl --output /bezwzgledna/sciezka/przekazania
```

Pakiet przekazania zawiera Markdown/HTML na podstawie zachowanego obrazu polityki. Sprawdź go przed udostępnieniem. Ogólne przewodniki PDF są instrukcją, a nie dowodem akceptacji telefonu.

## 8. Obsługuj flotę z osobnymi wynikami telefonów

Zarejestruj każdy fizyczny telefon oddzielnie. Sprawdź przypięty obraz każdego codename i plan każdego urządzenia. Zacznij od jednego telefonu, a równoległość zwiększaj świadomie; `--jobs` przyjmuje 1–8.

```sh
pxv fleet provision --project-root "$P" --group PARTIA --jobs 2 --dry-run
pxv fleet provision --project-root "$P" --group PARTIA --jobs 2 --operator "$OPERATOR"
```

Drugie polecenie przygotowuje nowe plany i prosi o potwierdzenie. Najpierw przeczytaj wyświetlony przegląd. Śledź każdą operację osobno; sukces jednego telefonu nie zalicza etapu innego ani nie usuwa jego błędu. Potwierdzenia, finalizacja, zmiany rejestru i odzyskiwanie dotyczą dokładnie jednego urządzenia. Instalację systemu we flocie przeprowadzaj w osobnym etapie, obsługując komunikaty każdego telefonu.

## 9. Zachowuj aktualne dane do uprawnionego wsparcia

Lokalny szyfrowany rejestr łączy identyfikator zasobu, numer seryjny sprzętu i codename z trwałymi tożsamościami profili Androida. Może przechowywać numer telefonu i parę PIN/hasło przymusu urządzenia oraz PIN/hasło, klucz Oblivion, identyfikator komunikatora Session, login/hasło Proton VPN i opcjonalny numer telefonu każdego profilu. Współdzielone konta zapisuj jawnie; identyfikator Session nie jest identyfikatorem użytkownika Androida.

```sh
pxv registry init --project-root "$P"
pxv registry update --project-root "$P" --asset "$ASSET" \
  --file /prywatny/katalog/telefon.json --record-revision 0
pxv registry show --project-root "$P" --asset "$ASSET"
```

Rewizja zero służy wyłącznie do pierwszego wpisu; przy zmianie podaj rewizję z `show`. Aktualizacja zastępuje cały bieżący rekord telefonu i zachowuje wszystkie wcześniejsze rewizje w szyfrowanej historii. Stany to `initial`, `current`, `unknown` i `stale`; `current` oznacza ostatnie jawne potwierdzenie operatora, a nie automatyczny odczyt z telefonu. Po prywatnej zmianie danych uzgodnij aktualizację rejestru.

Odblokowanie odbywa się w ukrytym lokalnym monicie. Prywatne wejścia i wyniki wymagają własnego pliku `0600` w katalogu `0700`. `list`, `show` i `history` pomijają wartości; `reveal --asset ID --output NOWY_PRYWATNY_PLIK` celowo zapisuje tekst jawny. `rekey` zmienia hasło szyfrowania. `reconcile` jawnie przyjmuje przywróconą kopię lub przerwany zapis, dodając nieaktualne rewizje; następnie ponownie potwierdź aktualne dane. Najpierw przeczytaj [zasady rejestru, historii i odzyskiwania](../../../docs/PHONE_REGISTRY.md).

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

Bez fizycznego telefonu testowego najkrótsza próba wymaga nowego osobnego projektu i polityki z danymi syntetycznymi:

```sh
pxv project init --path /prywatna/sciezka/proba-offline --policy /sciezka/polityki-syntetycznej.json
pxv policy validate --project-root /prywatna/sciezka/proba-offline
pxv guide project --project-root /prywatna/sciezka/proba-offline --kind pixel --locale pl
```

Inicjalizacja zapisuje blokadę wersji. Programiści mogą też uruchomić testy rejestru i przebiegu z atrapą portu urządzenia. Sprawdza to stronę hosta; nie kwalifikuje flashowania, receptur UI, VPN, odtwarzania ani fizycznego przekazania. Nie zastępuj niedostępnego telefonu testowego podstawowym telefonem użytkownika.

Korzystaj z [listy poleceń](../../../docs/COMMAND_REFERENCE.md), [automatyzacji i MCP](../../../docs/AUTOMATION.md), [obsługi Dockera](../../../docs/DOCKER.md), [zasad bezpieczeństwa](../../../SECURITY.md) i [stanu weryfikacji](../../../docs/VERIFICATION.md). Community wyłącza opcjonalne rozszerzenia i eksperymentalną automatyzację Seedvault; ręczna kopia i odtworzenie pozostają osobną, sprawdzaną procedurą telefonu. Historyczne wyniki fizyczne dotyczą wyłącznie zapisanej wersji, a nie bieżącej kompilacji.
