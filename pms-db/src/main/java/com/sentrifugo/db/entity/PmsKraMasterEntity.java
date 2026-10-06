package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsMasterStatus;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

/** Screens 2.5 and 2.6 - Key Result Area master. */
@Entity
@Table(
        name = "kra_master",
        schema = "pms",
        indexes = {
                @Index(name = "idx_kra_master_org", columnList = "organisation_id"),
                @Index(name = "idx_kra_master_status", columnList = "status"),
                @Index(name = "idx_kra_master_name", columnList = "name")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsKraMasterEntity extends BaseEntity<UUID> {

    @Column(name = "organisation_id", nullable = false)
    private String organisationId;

    @Column(name = "name", nullable = false, length = 200)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsMasterStatus status;
}
