import { Component, OnInit, ChangeDetectionStrategy, EventEmitter, Output, ViewChild, HostListener, ElementRef, Input } from '@angular/core';
import { UntypedFormBuilder, UntypedFormGroup, Validators } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { EventType, NavigationStart, Router } from '@angular/router';
import { StateService } from '@app/services/state.service';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, startWith, tap } from 'rxjs/operators';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { SearchResultsComponent } from '@components/search-form/search-results/search-results.component';

interface XmrSearchResults {
  searchText: string;
  hashQuickMatch: boolean;
  blockHeight: boolean;
  blockOrTxHash: boolean;
}

@Component({
  selector: 'app-search-form',
  templateUrl: './search-form.component.html',
  styleUrls: ['./search-form.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchFormComponent implements OnInit {
  @Input() hamburgerOpen = false;
  isSearching = false;
  isTypeaheading$ = new BehaviorSubject<boolean>(false);
  typeAhead$: Observable<XmrSearchResults>;
  searchForm: UntypedFormGroup;
  dropdownHidden = true;

  @HostListener('document:click', ['$event'])
  onDocumentClick(event) {
    if (this.elementRef.nativeElement.contains(event.target)) {
      this.dropdownHidden = false;
    } else {
      this.dropdownHidden = true;
    }
  }

  @Output() searchTriggered = new EventEmitter();
  @ViewChild('searchResults') searchResults: SearchResultsComponent;
  @HostListener('keydown', ['$event']) keydown($event): void {
    this.handleKeyDown($event);
  }

  @ViewChild('searchInput') searchInput: ElementRef;

  private emptySearchResults(searchText = ''): XmrSearchResults {
    return {
      searchText,
      hashQuickMatch: false,
      blockHeight: false,
      blockOrTxHash: false,
    };
  }

  constructor(
    private formBuilder: UntypedFormBuilder,
    private router: Router,
    private stateService: StateService,
    private relativeUrlPipe: RelativeUrlPipe,
    private elementRef: ElementRef,
    private http: HttpClient,
  ) {
  }

  ngOnInit(): void {
    this.router.events.subscribe((e: NavigationStart) => { // Reset search focus when changing page
      if (this.searchInput && e.type === EventType.NavigationStart) {
        this.searchInput.nativeElement.blur();
      }
    });

    this.stateService.searchFocus$.subscribe(() => {
      if (!this.searchInput) { // Try again a bit later once the view is properly initialized
        setTimeout(() => this.searchInput.nativeElement.focus(), 100);
      } else if (this.searchInput) {
        this.searchInput.nativeElement.focus();
      }
    });

    this.searchForm = this.formBuilder.group({
      searchText: ['', Validators.required],
    });

    const searchText$ = this.searchForm.get('searchText').valueChanges
    .pipe(
      map((text) => {
        return text.trim();
      }),
      tap((text) => {
        this.stateService.searchText$.next(text);
      }),
      distinctUntilChanged(),
    );

    this.typeAhead$ = searchText$.pipe(
      debounceTime(100),
      map((searchText) => this.buildSearchResults(searchText)),
      startWith(this.emptySearchResults()),
    );
  }

  handleKeyDown($event): void {
    this.searchResults.handleKeyDown($event);
  }

  itemSelected(): void {
    setTimeout(() => this.search());
  }

  selectedResult(result: any): void {
    if (typeof result === 'string') {
      this.search(result);
    }
  }

  search(result?: string): void {
    // xmr-space: simplified search resolver. Monero has no
    // chain-traceable address (so /address routes don't apply) and the
    // upstream `blockhash` regex requires Bitcoin-style leading-zero
    // hashes which Monero doesn't produce. Resolution rules:
    //   numeric → /block/<height>      (caps at current chain tip)
    //   64-hex  → probe /api/v1/block/:h ; if 200 → /block/:h
    //                                    ; else fall through to /tx/:h
    //   else    → no-op
    const searchText = result || this.searchForm.value.searchText.trim();
    if (!searchText) return;
    this.isSearching = true;

    const HEX64 = /^[a-f0-9]{64}$/i;
    const NUMERIC = /^[0-9]+$/;

    if (NUMERIC.test(searchText)) {
      const h = parseInt(searchText, 10);
      const tip = this.stateService.latestBlockHeight;
      if (Number.isSafeInteger(h) && h >= 0 && (tip < 0 || h <= tip)) {
        this.navigate('/block/', String(h));
      } else {
        this.isSearching = false;
      }
      return;
    }
    if (HEX64.test(searchText)) {
      // Try block first; if 404, try tx. Both target components
      // tolerate a not-found response with their own 404 UI.
      this.http
        .get(`/api/v1/block/${searchText}`, { observe: 'response' })
        .pipe(catchError(() => of(null)))
        .subscribe((resp: any) => {
          if (resp && resp.ok) {
            this.navigate('/block/', searchText);
          } else {
            this.navigate('/tx/', searchText);
          }
        });
      return;
    }
    this.isSearching = false;
  }


  navigate(url: string, searchText: string) {
    this.router.navigate([this.relativeUrlPipe.transform(url), searchText]);
    this.searchTriggered.emit();
    this.searchForm.setValue({
      searchText: '',
    });
    this.isSearching = false;
  }

  private buildSearchResults(searchText: string): XmrSearchResults {
    if (!searchText.length) {
      return this.emptySearchResults();
    }

    const searchHeight = parseInt(searchText, 10);
    const matchesBlockHeight = /^[0-9]+$/.test(searchText)
      && (this.stateService.latestBlockHeight < 0 || searchHeight <= this.stateService.latestBlockHeight);
    const matchesXmrHash = /^[a-f0-9]{64}$/i.test(searchText);

    return {
      searchText,
      hashQuickMatch: matchesBlockHeight || matchesXmrHash,
      blockHeight: matchesBlockHeight,
      blockOrTxHash: matchesXmrHash,
    };
  }
}
