import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';

@Component({
  selector: 'app-search-results',
  templateUrl: './search-results.component.html',
  styleUrls: ['./search-results.component.scss'],
  standalone: false,
})
export class SearchResultsComponent implements OnChanges {
  @Input() results: any = {};
  @Output() selectedResult = new EventEmitter();

  isMobile = (window.innerWidth <= 1150);
  resultsFlattened = [];
  activeIdx = 0;
  focusFirst = true;

  ngOnChanges() {
    this.activeIdx = 0;
    if (this.results) {
      this.resultsFlattened = this.results.hashQuickMatch ? [this.results.searchText] : [];
    }
  }

  searchButtonClick() {
    if (this.resultsFlattened[this.activeIdx]) {
      this.selectedResult.emit(this.resultsFlattened[this.activeIdx]);
      this.results = null;
    }
  }

  handleKeyDown(event: KeyboardEvent) {
    if (!this.results) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.next();
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.prev();
        break;
      case 'Enter':
        event.preventDefault();
        if (this.resultsFlattened[this.activeIdx]?.isNetworkAvailable === false) {
          return;
        }
        if (this.resultsFlattened[this.activeIdx]) {
          this.selectedResult.emit(this.resultsFlattened[this.activeIdx]);
        } else {
          this.selectedResult.emit(this.results.searchText);
        }
        this.results = null;
        break;
    }
  }

  clickItem(id: number) {
    this.selectedResult.emit(this.resultsFlattened[id]);
    this.results = null;
  }

  next() {
    if (!this.resultsFlattened.length) {
      return;
    }
    if (this.activeIdx === this.resultsFlattened.length - 1) {
      this.activeIdx = this.focusFirst ? (this.activeIdx + 1) % this.resultsFlattened.length : -1;
    } else {
      this.activeIdx++;
    }
  }

  prev() {
    if (!this.resultsFlattened.length) {
      return;
    }
    if (this.activeIdx < 0) {
      this.activeIdx = this.resultsFlattened.length - 1;
    } else if (this.activeIdx === 0) {
      this.activeIdx = this.focusFirst ? this.resultsFlattened.length - 1 : -1;
    } else {
      this.activeIdx--;
    }
  }

}
