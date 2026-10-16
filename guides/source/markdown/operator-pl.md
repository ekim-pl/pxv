# Podręcznik operatora

Ten przewodnik opisuje pxv 0.1.0. Nie jest certyfikatem telefonu. Dopiero zaakceptowany zapis projektu wskazuje konkretną politykę, oprogramowanie, wyniki sprawdzeń i przekazanie urządzenia. Dowody kwalifikacji wydania oraz testów fizycznego telefonu przechowuje się oddzielnie.

![Przygotowanie i przekazanie telefonu](../../assets/diagrams/workflow-pl.svg)

## Odpowiedzialność i prywatność

Operator odpowiada za host, identyfikację telefonu, dane projektu i przegląd polityki. Odbiorca sam wprowadza końcową blokadę ekranu, konta, MFA oraz dane odzyskiwania. Przed rozpoczęciem uzgodnij zastosowania telefonu, układ profili, wsparcie, kopie zapasowe i zgodę na ewentualne wymazanie. Nie wpisuj sekretów do manifestu, receptury, notatki, zrzutu ekranu, wejścia rozszerzenia ani protokołu sesji.

Korzystaj z wydzielonego autoryzowanego telefonu. Gotowe pakiety z jednym, pięcioma i dowolnie nazwanymi profilami pokazują strukturę; nie stanowią zatwierdzonych polityk utwardzania. Nie zawierają zmyślonych zaufanych skrótów APK ani kluczy OS.

## Host i nowy projekt

Pierwszą platformą jest Linux x86_64. Weryfikacja obejmuje Debian 12 i Ubuntu 24.04. Wersje narzędzi są przypięte: Node 24.22.0 LTS, kompilator TypeScript 7.0.2 i pnpm 12.11.2. Archiwum przenośne oraz pakiet Debian zawierają Node i nadzorcę Linux; pakiet npm wymaga obsługiwanej instalacji Node. Kod źródłowy wymaga również Rust do zbudowania nadzorcy.

~~~sh
pnpm install --frozen-lockfile
pnpm build:native
pnpm build
pnpm check
pnpm test
~~~

Dalsze przykłady używają zainstalowanego polecenia `pxv`. W drzewie źródłowym użyj `pnpm pxv`. Utwórz prywatny projekt poza instalacją i repozytorium:

~~~sh
P="$HOME/pxv-projects/lab"
pxv host doctor
pxv project init --path "$P"
pxv policy validate --project-root "$P"
pxv host adb-start --yes
~~~

`host doctor` sprawdza narzędzia i istniejący punkt ADB. Nie uruchamia serwera i niczego nie pobiera. Jawne polecenie `host bootstrap` wymaga zatwierdzonego opisu archiwum HTTPS, skrótu SHA-256, identyfikatora zaakceptowanej licencji i nowego katalogu docelowego. Budowanie helperów Android jest także jawne i wymaga SDK. Prywatne klucze podpisujące helperów pozostają w projekcie.

Projekt zawiera `pxv.project.json` z formatem `pxv-ts`, `policy.yaml`, `inventory.json`, `policy.lock.json` oraz bazę SQLite w `state/`. Stary format jest wykrywany i odrzucany bez modyfikacji. Nie ma importera zatwierdzeń ani warstwy zgodności starej aplikacji.

## Polityka i tożsamość urządzenia

Sprawdź oficjalny obraz OS, kod urządzenia, podpis i zaufany klucz, wersje APK, skróty treści, przypięte podpisy aplikacji i repozytoriów, profile, uprawnienia, ustawienia, VPN, transport kopii oraz wymagane kontrole ręczne. Wymagany jest dokładnie jeden profil właściciela. Liczba i nazwy pozostałych profili zależą od wdrożenia.

Blokada polityki wiąże produkt, silnik, konfigurację, artefakty i rozszerzenia. Zmiana któregokolwiek z tych elementów wymaga nowego przeglądu. Powtórzone klucze i nieznane pola są błędami.

~~~sh
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P" --yes
pxv inventory enroll --project-root "$P" --asset lab-01 \
  --serial YOUR_OBSERVED_SERIAL --model 'Pixel 8a' --codename akita --yes
pxv device inspect --project-root "$P" --asset lab-01
pxv device plan --project-root "$P" --asset lab-01
~~~

Zastąp przykładowy numer rzeczywiście odczytanym numerem tego telefonu. Porównaj etykietę, model, kod urządzenia i monit autoryzacji USB. Pierwsza rejestracja używa USB albo dedykowanego emulatora. Tryb `--mode fastboot` pozwala zarejestrować sprawdzony telefon w fastboot do instalacji OS.

Zasób nazwany `all` wybiera się dokładnie przez `--asset all`. Flota wymaga `--all` lub `--group`; nazwa zasobu nie jest symbolem wieloznacznym. Nie używaj planu jednego telefonu do innego.

## Przegląd i wykonanie

Plan opisuje tożsamość, transport, aktualne obserwacje, utrwalone artefakty i skutki dotyczące innych użytkowników Androida. Kod i wersja APK mogą zmienić się globalnie mimo osobnych danych użytkowników. Sprawdź te skutki przed zatwierdzeniem. `--yes` potwierdza konkretny przegląd w automatyzacji; nie zastępuje sprawdzenia telefonu.

~~~sh
pxv device provision --project-root "$P" --asset lab-01 --operator 'Operator'
pxv agent runs --project-root "$P"
pxv agent status --project-root "$P" --run RUN_ID --after 0
~~~

Pełny przebieg, `device deploy` i tworzenie użytkowników korzystają ze wspólnych usług. Instalacja aplikacji ma jedną ścieżkę weryfikacji. Sam skrót pliku nie dowodzi tożsamości wydawcy: potrzebne są zaufane przypięcia podpisów. Repozytoria sprawdzają również aktualność i próby cofnięcia wersji.

Wynik oczekujący nie oznacza ukończenia. Wykonaj dokładnie wskazaną kontrolę ręczną, zapisz nazwane poświadczenie i wznów ten sam przebieg. Normalne dane uwierzytelniające poprzedzają język końcowy, a opcjonalny duress jest później. Nie uruchamiaj destrukcyjnego duress w ramach testu.

~~~sh
pxv device attest --project-root "$P" --asset lab-01 \
  --check normal_credentials --operator 'Operator' --yes
pxv agent resume --project-root "$P" --run RUN_ID --yes
~~~

Receptura UI jest związana z odciskiem OS i dokładną wersją/podpisem aplikacji. Nieobsługiwany ekran pozostaje zadaniem ręcznym. Próba kliknięcia nie dowodzi wykonania konfiguracji. Notatka nie może zastąpić pomiaru, który przeczy wymaganiu polityki.

Jeżeli przegląd pozostałej pracy wygaśnie, użyj `agent refresh --run RUN_ID`. Otrzymasz nowy plan wyłącznie niewykonanych kroków, jego `planId`, dokładny `reviewSummary` i termin. Zapisz zdekodowaną treść reviewSummary bez zmian w prywatnym pliku, sprawdź nowy plan i użyj `agent execute --plan NEW_PLAN_ID --review-file FILE --operator NAME`. Odświeżenie samo nie zatwierdza ani nie wykonuje zmian; przerwana mutacja nadal wymaga inspekcji i odzyskiwania.

## Instalacja systemu i wymazanie

Instaluj OS tylko po uzyskaniu jawnej zgody na wymazanie tego telefonu. Polityka musi przypinać oficjalne adresy obrazu i podpisu, kod urządzenia, przestrzeń nazw/principal OpenSSH i autentyczny klucz publiczny. Fastboot wymaga bezpośredniego USB i dokładnego numeru. Sam host-ADB w Dockerze nie wystarcza.

~~~sh
pxv device install-os --project-root "$P" --asset lab-01 --operator 'Operator'
~~~

Instalator weryfikuje podpis i treść, a następnie wykonuje uwierzytelniony skrypt przez wrapper wymuszający numer fastboot. Operator nadzoruje odblokowanie, stan blokady, ponowne zablokowanie i pierwszy start. Nie blokuj bootloadera na niezweryfikowanym obrazie. Przerwana instalacja wymaga inspekcji. Stosuj oficjalną instrukcję GrapheneOS dla konkretnego modelu i zatrzymaj pracę, gdy stan telefonu odbiega od oczekiwań.

## Docker i niezależne ADB

Obraz ma przypiętą bazę i narzędzia, a worker działa jako UID/GID operatora. Projekty, współdzielona kontrola hosta, rozszerzenia i prywatne klucze ADB są zewnętrzne. Rozszerzenia montuje się tylko do odczytu. Zbuduj jawny lokalny obraz i podstaw jego unikalny tag:

~~~sh
pnpm build:preview --formats oci
pxv host docker-prepare --yes
pxv host docker-adb-start --image YOUR_UNIQUE_IMAGE --yes
pxv host doctor --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode direct
pxv device inspect --project-root "$P" --asset lab-01 \
  --execution docker --image YOUR_UNIQUE_IMAGE --docker-mode direct
~~~

Usługa ADB jest osobno uruchamiana i używa loopback 5038. Worker nie uruchamia jej w swojej grupie mutacji. Tryb host-ADB używa już działającego serwera hosta, zwykle 5037. Uprawnienia USB i grupy zależą od hosta. Zakończ wyłącznie usługę należącą do operatora przez `host docker-adb-stop --yes`. Compose stanowi jawną alternatywę uruchomienia usług; nie pobiera ani nie publikuje obrazu automatycznie.

## Przerwanie i odzyskiwanie

Nadzorca Rust utrwala prywatne, zredagowane dowody właściciela procesu i zakończenia. Dane polecenia i środowiska przechodzą prywatnym IPC, a nie do trwałego dziennika. Utrata procesu Node nie oznacza zakończonego sprzątania. Rezerwacja urządzenia i transportu obowiązuje też inne projekty, forki, podglądy i kontenery na tym hoście. Równoległa kontrola z kilku stacji jest nieobsługiwana.

~~~sh
pxv agent cancel --project-root "$P" --run RUN_ID
pxv device recover --project-root "$P" --asset lab-01
pxv device recover --project-root "$P" --asset lab-01 \
  --run ORIGINAL_RUN_ID --inspected --yes
~~~

Najpierw obejrzyj telefon i zapisane zobowiązania. Odzyskiwanie wiąże użytkownika z jego stabilnym numerem seryjnym Androida, nie tylko ponownie użytym ID i nazwą. Nowo utworzony użytkownik nie jest starym celem sprzątania. Podoperacja sondy sieciowej zwalnia tylko własne zasoby, nigdy zasoby całego wdrożenia.

Nieudane odzyskiwanie zachowuje rezerwację i historię prób. Żywego nadzorcy nie da się ominąć potwierdzeniem ręcznym. Nieudowodnione sprzątanie procesów może wymagać restartu hosta i inspekcji. Nigdy nie usuwaj blokad, bazy ani pokwitowań, żeby wymusić gotowość. Przerwane mutacje nie są samoczynnie odtwarzane. Anulowanie nie cofa dowolnego flashowania, zmiany aplikacji ani wpisania konta.

## Pomiar, akceptacja i przekazanie

Po restarcie sprawdź trwałość ustawień, izolację użytkowników, trasowanie, zachowanie przy awarii i reprezentatywne odtworzenie kopii. Włączony backup nie dowodzi odtworzenia. Ikona VPN nie dowodzi całego ruchu. Sonda obejmuje własny UID i zatwierdzone punkty HTTPS; sprawdź osobno faktyczne aplikacje.

Poświadczenia wymagają świeżych obserwacji. Obecne okno świeżości wynosi 15 minut. Finalizacja ponownie mierzy ustawienia i wymagane uprawnienia; odrzuca dryf, helpery, nierozwiązane sprzątanie i nieaktualne dowody. Raport opisuje zapisany stan, a nie nowe badanie telefonu.

~~~sh
pxv device report --project-root "$P" --asset lab-01
pxv device finalize --project-root "$P" --asset lab-01 --operator 'Operator' --locale pl
pxv handoff accept --project-root "$P" --asset lab-01 \
  --recipient 'Odbiorca' --debugging-off --yes
pxv handoff export --project-root "$P" --asset lab-01 --locale pl --output "$P/handoff"
~~~

Odczytaj wynik finalizacji. Fizycznie potwierdź wyłączenie debugowania i brak tymczasowych helperów. Gotowość do przekazania różni się od przyjęcia urządzenia przez odbiorcę. Wynik częściowy lub emulator nie potwierdza gotowości telefonu fizycznego. Zachowaj dokument z zaakceptowanego snapshotu; nie zawiera on sekretów odbiorcy.

Eksport przekazania używa zaakceptowanego snapshotu produktu i rozwiązanej polityki, a nie bieżącego edytowanego pliku. Historyczny dokument zachowuje dowód dawnego przekazania, ale nie potwierdza aktualnej gotowości. CLI eksportuje Markdown i HTML; PDF wymaga jawnego narzędzia/API, bez flagi PDF w CLI.

## Serwis, rozszerzenia i fork

`lifecycle maintenance`, `policy-change`, `loss` i `retirement` zapisują zdarzenia z operatorem i notatką. Serwis wymaga świeżych dowodów i ponownego przekazania. Utrata wymaga reakcji u właścicieli kont; sam zapis nie wymazuje zdalnie telefonu. Wycofanie rejestruje osobno potwierdzone wymazanie i przekazanie pieczy, bez automatycznego wipe.

Rozszerzenia z dokładnymi wersjami instaluje się jawnie z prywatnego rejestru lub lokalnego tarballa. Brak skryptów instalacyjnych i pobierania zależności w czasie uruchomienia. Zainstalowane narzędzie działa offline. Rozszerzenie jest zaufanym kodem, a worker nie stanowi piaskownicy bezpieczeństwa. Akcje zmieniające telefon podlegają zwykłemu przeglądowi silnika. Zmiana wybranego pakietu polityki wymaga nowej blokady i zatwierdzenia.

Wersja white-label jest osobnym forkiem z własnymi zasobami, manifestami i konfiguracją produktu. Zachowaj marker silnika/API i testy bezpieczeństwa. Sekrety rejestru, klucze ADB i dane projektów nie należą do forków ani obrazów. Wydania próbne mają unikalne katalogi, wersje i nazwy; zwykły build niczego nie publikuje ani nie zastępuje stabilnego launchera.

## Lista zamknięcia sesji

1. Wyjaśnij każdy oczekujący punkt i nierozwiązane sprzątanie.
2. Zbierz nowe pomiary po restarcie oraz reprezentatywnym restore.
3. Potwierdź prywatne wpisanie końcowych danych przez odbiorcę.
4. Usuń helpery i fizycznie potwierdź wyłączenie debugowania.
5. Zachowaj zaakceptowany dokument EN/PL oraz zapis pieczy.
6. Odłącz telefon i zabezpiecz prywatny projekt.
7. Zapisz nieukończoną kwalifikację zgodnie z faktami.

Testy offline nie certyfikują polityki ani przepływu UI. Kwalifikacja wymaga zachowanych dowodów emulatora GrapheneOS i autoryzowanego Pixel 8a w EN/PL, z izolacją, restartem, routingiem, awarią, restore i przekazaniem. Zwykły emulator Google APIs nie jest dowodem pochodzenia GrapheneOS.

## Wskazówki z wybranej polityki

Polecenie `pxv guide project --project-root "$P" --locale pl --kind pixel` wypisuje profile, wymagane kontrole i kolejność prywatnej konfiguracji z bieżącej polityki. `--kind emulator` wybiera wymagania emulatora. `pxv device guided --project-root "$P" --asset lab-01 --operator 'Operator' --locale pl` pokazuje te wskazówki i korzysta ze wspólnej ścieżki przygotowania, zwracając konkretne dalsze kroki przy oczekiwaniu. Wariant `--dry-run` przygotowuje przegląd bez zmiany telefonu. Ogólne przewodniki pozostają oddzielne. Wskazówka nie podaje sekretu, nie zastępuje pomiaru i nie potwierdza automatycznie ręcznego etapu.
