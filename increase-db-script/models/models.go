package models

import (
	"math/big"
	"time"
)

// ReleaseType corresponds to the Java enum ReleaseType
type ReleaseType string

const (
	ReleaseTypeE ReleaseType = "E"
	ReleaseTypeR ReleaseType = "R"
	ReleaseTypeT ReleaseType = "T"
)

// ReleaseRepeat corresponds to the Java enum ReleaseRepeat
type ReleaseRepeat string

const (
	ReleaseRepeatFixed        ReleaseRepeat = "FIXED"
	ReleaseRepeatInstallments ReleaseRepeat = "INSTALLMENTS"
)

// ReleaseFixedBy corresponds to the Java enum ReleaseFixedby
type ReleaseFixedBy string

const (
	ReleaseFixedByDaily     ReleaseFixedBy = "DAILY"
	ReleaseFixedByWeekly    ReleaseFixedBy = "WEEKLY"
	ReleaseFixedByMonthly   ReleaseFixedBy = "MONTHLY"
	ReleaseFixedByBimonthly ReleaseFixedBy = "BIMONTHLY"
	ReleaseFixedByQuarterly ReleaseFixedBy = "QUARTERLY"
	ReleaseFixedByBiannual  ReleaseFixedBy = "BIANNUAL"
	ReleaseFixedByAnnual    ReleaseFixedBy = "ANNUAL"
)

// Release maps to the Java Release entity
type Release struct {
	ID                  int64           `db:"id"`
	UserID              int64           `db:"user_id"`
	Description         *string         `db:"description"`
	AccountID           *int64          `db:"account_id"`
	Amount              big.Float       `db:"amount"`
	Type                ReleaseType     `db:"type"`
	Done                bool            `db:"done"`
	TargetAccountID     *int64          `db:"target_account_id"`
	CategoryID          *int64          `db:"category_id"`
	Date                time.Time       `db:"date"`
	Time                *string         `db:"time"`
	Observation         *string         `db:"observation"`
	S3FileName          *string         `db:"s3_file_name"`
	AttachmentName      *string         `db:"attachment_name"`
	DuplicatedReleaseID *int64          `db:"duplicated_release_id"`
	Repeat              *ReleaseRepeat  `db:"repeat"`
	FixedBy             *ReleaseFixedBy `db:"fixed_by"`
	CreditCardID        *int64          `db:"credit_card_id"`
	IsBalanceAdjustment bool            `db:"is_balance_adjustment"`
}
