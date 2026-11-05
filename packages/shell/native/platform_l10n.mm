// The shell's own menu labels (the standard menus, roles' default titles) in the user's language,
// among the ones the app declares (desktop.config `locales` → CFBundleLocalizations and .lproj
// folders): NSBundle picks it as it does for any app, so an app in English only keeps English menus,
// as AppKit's own do. The wording follows macOS's own menus. Labels an app writes itself are its
// own: only these exact English strings are translated.
#import "platform_internal.h"

static NSDictionary<NSString *, NSDictionary<NSString *, NSString *> *> *tables(void) {
  static NSDictionary *t;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSArray *keys = @[
      @"File", @"Edit", @"View", @"Window", @"Help", @"Services", @"Undo", @"Redo", @"Cut", @"Copy", @"Paste", @"Paste and Match Style",
      @"Delete", @"Select All", @"Minimize", @"Zoom", @"Close", @"Close Window", @"Toggle Full Screen", @"Enter Full Screen", @"Start Speaking",
      @"Stop Speaking", @"Hide Others", @"Show All", @"Bring All to Front", @"Reload", @"Zoom In", @"Zoom Out", @"Actual Size",
      @"Toggle Developer Tools", @"About %@", @"Hide %@", @"Quit %@"
    ];
    NSDictionary<NSString *, NSArray<NSString *> *> *rows = @{
      @"fr" : @[
        @"Fichier", @"Édition", @"Présentation", @"Fenêtre", @"Aide", @"Services", @"Annuler", @"Rétablir", @"Couper", @"Copier", @"Coller",
        @"Coller et adapter le style", @"Supprimer", @"Tout sélectionner", @"Placer dans le Dock", @"Réduire/agrandir", @"Fermer",
        @"Fermer la fenêtre", @"Activer/désactiver le mode plein écran", @"Passer en mode plein écran", @"Commencer la lecture",
        @"Arrêter la lecture", @"Masquer les autres", @"Tout afficher", @"Tout ramener au premier plan", @"Recharger", @"Zoom avant",
        @"Zoom arrière", @"Taille réelle", @"Afficher/masquer les outils de développement", @"À propos de %@", @"Masquer %@", @"Quitter %@"
      ],
      @"de" : @[
        @"Ablage", @"Bearbeiten", @"Darstellung", @"Fenster", @"Hilfe", @"Dienste", @"Widerrufen", @"Wiederholen", @"Ausschneiden",
        @"Kopieren", @"Einsetzen", @"Einsetzen und Stil anpassen", @"Löschen", @"Alles auswählen", @"Im Dock ablegen", @"Zoomen",
        @"Schließen", @"Fenster schließen", @"Vollbildmodus ein/aus", @"Vollbildmodus aktivieren", @"Sprachausgabe starten",
        @"Sprachausgabe stoppen", @"Andere ausblenden", @"Alle einblenden", @"Alle nach vorne bringen", @"Neu laden", @"Vergrößern",
        @"Verkleinern", @"Originalgröße", @"Entwicklerwerkzeuge ein/aus", @"Über %@", @"%@ ausblenden", @"%@ beenden"
      ],
      @"es" : @[
        @"Archivo", @"Edición", @"Visualización", @"Ventana", @"Ayuda", @"Servicios", @"Deshacer", @"Rehacer", @"Cortar", @"Copiar", @"Pegar",
        @"Pegar con el mismo estilo", @"Eliminar", @"Seleccionar todo", @"Minimizar", @"Zoom", @"Cerrar", @"Cerrar ventana",
        @"Activar/desactivar pantalla completa", @"Usar pantalla completa", @"Empezar a leer en voz alta", @"Detener lectura",
        @"Ocultar otros", @"Mostrar todo", @"Traer todo al frente", @"Volver a cargar", @"Ampliar", @"Reducir", @"Tamaño real",
        @"Mostrar/ocultar herramientas para desarrolladores", @"Acerca de %@", @"Ocultar %@", @"Salir de %@"
      ],
      @"it" : @[
        @"Archivio", @"Composizione", @"Vista", @"Finestra", @"Aiuto", @"Servizi", @"Annulla", @"Ripeti", @"Taglia", @"Copia", @"Incolla",
        @"Incolla e adatta stile", @"Elimina", @"Seleziona tutto", @"Contrai", @"Zoom", @"Chiudi", @"Chiudi finestra",
        @"Attiva/disattiva modalità a tutto schermo", @"Attiva modalità a tutto schermo", @"Inizia lettura", @"Interrompi lettura",
        @"Nascondi altre", @"Mostra tutte", @"Porta tutto in primo piano", @"Ricarica", @"Ingrandisci", @"Riduci", @"Dimensioni reali",
        @"Mostra/nascondi strumenti per sviluppatori", @"Informazioni su %@", @"Nascondi %@", @"Esci da %@"
      ],
      @"pt" : @[
        @"Arquivo", @"Editar", @"Visualizar", @"Janela", @"Ajuda", @"Serviços", @"Desfazer", @"Refazer", @"Recortar", @"Copiar", @"Colar",
        @"Colar e Manter Estilo", @"Apagar", @"Selecionar Tudo", @"Minimizar", @"Zoom", @"Fechar", @"Fechar Janela",
        @"Ativar/Desativar Tela Cheia", @"Entrar em Tela Cheia", @"Iniciar Fala", @"Parar Fala", @"Ocultar Outros", @"Mostrar Tudo",
        @"Trazer Todas para a Frente", @"Recarregar", @"Aumentar Zoom", @"Diminuir Zoom", @"Tamanho Real",
        @"Mostrar/Ocultar Ferramentas de Desenvolvedor", @"Sobre o %@", @"Ocultar %@", @"Encerrar %@"
      ],
      @"nl" : @[
        @"Archief", @"Wijzig", @"Weergave", @"Venster", @"Help", @"Voorzieningen", @"Herstel", @"Opnieuw", @"Knip", @"Kopieer", @"Plak",
        @"Plak en behoud stijl", @"Verwijder", @"Selecteer alles", @"Minimaliseer", @"Zoom", @"Sluit", @"Sluit venster",
        @"Schakel schermvullende weergave in/uit", @"Schakel schermvullende weergave in", @"Begin met spreken", @"Stop met spreken",
        @"Verberg andere", @"Toon alles", @"Alles op voorgrond", @"Laad opnieuw", @"Zoom in", @"Zoom uit", @"Werkelijke grootte",
        @"Toon/verberg ontwikkelaarstools", @"Over %@", @"Verberg %@", @"Stop %@"
      ],
      @"ja" : @[
        @"ファイル", @"編集", @"表示", @"ウインドウ", @"ヘルプ", @"サービス", @"取り消す", @"やり直す", @"カット", @"コピー", @"ペースト",
        @"ペーストしてスタイルを合わせる", @"削除", @"すべてを選択", @"しまう", @"拡大/縮小", @"閉じる", @"ウインドウを閉じる",
        @"フルスクリーンにする/解除", @"フルスクリーンにする", @"読み上げを開始", @"読み上げを停止", @"ほかを非表示", @"すべてを表示",
        @"すべてを手前に移動", @"再読み込み", @"拡大", @"縮小", @"実際のサイズ", @"開発ツールを表示/非表示", @"%@について", @"%@を非表示",
        @"%@を終了"
      ],
      @"zh-Hans" : @[
        @"文件", @"编辑", @"显示", @"窗口", @"帮助", @"服务", @"撤销", @"重做", @"剪切", @"拷贝", @"粘贴", @"粘贴并匹配样式", @"删除", @"全选",
        @"最小化", @"缩放", @"关闭", @"关闭窗口", @"切换全屏幕", @"进入全屏幕", @"开始朗读", @"停止朗读", @"隐藏其他", @"全部显示",
        @"前置全部窗口", @"重新载入", @"放大", @"缩小", @"实际大小", @"显示/隐藏开发者工具", @"关于%@", @"隐藏%@", @"退出%@"
      ],
      @"ko" : @[
        @"파일", @"편집", @"보기", @"윈도우", @"도움말", @"서비스", @"실행 취소", @"실행 복귀", @"오려두기", @"복사하기", @"붙여넣기",
        @"붙여넣기 및 스타일 일치", @"삭제", @"전체 선택", @"최소화", @"확대/축소", @"닫기", @"윈도우 닫기", @"전체 화면 전환",
        @"전체 화면 시작", @"말하기 시작", @"말하기 중단", @"기타 가리기", @"모두 보기", @"모두 앞으로 가져오기", @"새로 고침", @"확대",
        @"축소", @"실제 크기", @"개발자 도구 보기/가리기", @"%@에 관하여", @"%@ 가리기", @"%@ 종료"
      ],
      @"ru" : @[
        @"Файл", @"Правка", @"Вид", @"Окно", @"Справка", @"Службы", @"Отменить", @"Повторить", @"Вырезать", @"Скопировать", @"Вставить",
        @"Вставить и сохранить стиль", @"Удалить", @"Выбрать все", @"Свернуть", @"Изменить масштаб", @"Закрыть", @"Закрыть окно",
        @"Включить/выключить полноэкранный режим", @"Перейти в полноэкранный режим", @"Начать воспроизведение",
        @"Остановить воспроизведение", @"Скрыть остальные", @"Показать все", @"Все окна — на передний план", @"Перезагрузить",
        @"Увеличить", @"Уменьшить", @"Фактический размер", @"Показать/скрыть инструменты разработчика", @"О программе %@", @"Скрыть %@",
        @"Завершить %@"
      ],
    };
    // <WindowTabs>' Tab menu and Window menu items (src/tabs), worded like Safari's.
    NSArray *tabKeys = @[ @"Tab", @"New Tab", @"Close Tab", @"Reopen Closed Tab", @"Show Next Tab", @"Show Previous Tab", @"Select Tab", @"Move Tab to New Window", @"Close All" ];
    NSDictionary<NSString *, NSArray<NSString *> *> *tabRows = @{
      @"fr" : @[ @"Onglet", @"Nouvel onglet", @"Fermer l’onglet", @"Rouvrir l’onglet fermé", @"Afficher l’onglet suivant", @"Afficher l’onglet précédent", @"Sélectionner l’onglet", @"Déplacer l’onglet vers une nouvelle fenêtre", @"Tout fermer" ],
      @"de" : @[ @"Tab", @"Neuer Tab", @"Tab schließen", @"Geschlossenen Tab erneut öffnen", @"Nächsten Tab anzeigen", @"Vorherigen Tab anzeigen", @"Tab auswählen", @"Tab in neues Fenster bewegen", @"Alle schließen" ],
      @"es" : @[ @"Pestaña", @"Nueva pestaña", @"Cerrar pestaña", @"Reabrir pestaña cerrada", @"Mostrar pestaña siguiente", @"Mostrar pestaña anterior", @"Seleccionar pestaña", @"Mover pestaña a una ventana nueva", @"Cerrar todo" ],
      @"it" : @[ @"Pannello", @"Nuovo pannello", @"Chiudi pannello", @"Riapri pannello chiuso", @"Mostra pannello successivo", @"Mostra pannello precedente", @"Seleziona pannello", @"Sposta pannello in una nuova finestra", @"Chiudi tutto" ],
      @"pt" : @[ @"Aba", @"Nova Aba", @"Fechar Aba", @"Reabrir Aba Fechada", @"Mostrar Próxima Aba", @"Mostrar Aba Anterior", @"Selecionar Aba", @"Mover Aba para Nova Janela", @"Fechar Tudo" ],
      @"nl" : @[ @"Tabblad", @"Nieuw tabblad", @"Sluit tabblad", @"Open gesloten tabblad opnieuw", @"Toon volgend tabblad", @"Toon vorig tabblad", @"Selecteer tabblad", @"Verplaats tabblad naar nieuw venster", @"Sluit alles" ],
      @"ja" : @[ @"タブ", @"新規タブ", @"タブを閉じる", @"閉じたタブを再度開く", @"次のタブを表示", @"前のタブを表示", @"タブを選択", @"タブを新規ウインドウに移動", @"すべてを閉じる" ],
      @"zh-Hans" : @[ @"标签页", @"新建标签页", @"关闭标签页", @"重新打开已关闭的标签页", @"显示下一个标签页", @"显示上一个标签页", @"选择标签页", @"将标签页移到新窗口", @"全部关闭" ],
      @"ko" : @[ @"탭", @"새로운 탭", @"탭 닫기", @"닫은 탭 다시 열기", @"다음 탭 보기", @"이전 탭 보기", @"탭 선택", @"탭을 새로운 윈도우로 이동", @"모두 닫기" ],
      @"ru" : @[ @"Вкладка", @"Новая вкладка", @"Закрыть вкладку", @"Открыть закрытую вкладку", @"Показать следующую вкладку", @"Показать предыдущую вкладку", @"Выбрать вкладку", @"Переместить вкладку в новое окно", @"Закрыть все" ],
    };
    NSArray *allKeys = [keys arrayByAddingObjectsFromArray:tabKeys];
    NSMutableDictionary *out = [NSMutableDictionary new];
    for (NSString *lang in rows) {
      NSArray *row = [rows[lang] arrayByAddingObjectsFromArray:tabRows[lang] ?: @[]];
      if (row.count == allKeys.count) out[lang] = [NSDictionary dictionaryWithObjects:row forKeys:allKeys];
      else NSLog(@"[shell] l10n: the %@ table has %lu labels, expected %lu", lang, (unsigned long)row.count, (unsigned long)allKeys.count);
    }
    t = out;
  });
  return t;
}

static NSDictionary<NSString *, NSString *> *current(void) {
  static NSDictionary *table;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // The app's language for this user (CFBundleLocalizations ∩ their preferred languages). vite dev
    // has no bundle to declare them: KITOP_LOCALIZATIONS lists them instead, and
    // KITOP_LANGUAGE forces one.
    NSDictionary *env = NSProcessInfo.processInfo.environment;
    NSString *lang = env[@"KITOP_LANGUAGE"];
    if (!lang && [env[@"KITOP_LOCALIZATIONS"] length])
      lang = [NSBundle preferredLocalizationsFromArray:[env[@"KITOP_LOCALIZATIONS"] componentsSeparatedByString:@","] forPreferences:nil].firstObject;
    if (!lang) lang = NSBundle.mainBundle.preferredLocalizations.firstObject ?: @"en";
    NSDictionary *all = tables();
    table = all[lang];
    if (!table && [lang hasPrefix:@"zh"]) table = all[@"zh-Hans"];
    if (!table) table = all[[lang componentsSeparatedByCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"-_"]].firstObject];
  });
  return table;
}

NSString *platform_l10n(NSString *english) {
  NSDictionary *table = current();
  if (!table || !english.length) return english;
  if (NSString *t = table[english]) return t;
  for (NSString *prefix in @[ @"About ", @"Hide ", @"Quit " ]) {
    if (![english hasPrefix:prefix] || [english isEqual:@"Hide Others"]) continue;
    if (NSString *format = table[[prefix stringByAppendingString:@"%@"]])
      return [format stringByReplacingOccurrencesOfString:@"%@" withString:[english substringFromIndex:prefix.length]];
  }
  return english;
}
