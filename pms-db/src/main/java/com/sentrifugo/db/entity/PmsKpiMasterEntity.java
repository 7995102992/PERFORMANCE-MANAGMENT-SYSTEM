package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsMasterStatus;
import com.sentrifugo.db.enums.PmsTargetType;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

/** Screens 2.7 and 2.8 - Key Performance Indicator master, always under one KRA. */
@Entity
@Table(
        name = "kpi_master",
        schema = "pms",
        indexes = {
                @Index(name = "idx_kpi_master_org", columnList = "organisation_id"),
                @Index(name = "idx_kpi_master_kra", columnList = "kra_id"),
                @Index(name = "idx_kpi_master_status", columnList = "status"),
                @Index(name = "idx_kpi_master_name", columnList = "name")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsKpiMasterEntity extends BaseEntity<UUID> {

    @Column(name = "organisation_id", nullable = false)
    private String organisationId;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "kra_id", nullable = false)
    private PmsKraMasterEntity kra;

    @Column(name = "name", nullable = false, length = 200)
    private String name;

    @Column(name = "unit", nullable = false, length = 50)
    private String unit;

    @Enumerated(EnumType.STRING)
    @Column(name = "target_type", nullable = false, length = 30)
    private PmsTargetType targetType;

    @Column(name = "expected_outcome", length = 500)
    private String expectedOutcome;

    @Column(name = "evidence_required", length = 500)
    private String evidenceRequired;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsMasterStatus status;
}
