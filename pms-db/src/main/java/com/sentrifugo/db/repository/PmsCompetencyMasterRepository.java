package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCompetencyMasterEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsCompetencyMasterRepository extends JpaRepository<PmsCompetencyMasterEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsCompetencyMasterEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);

    List<PmsCompetencyMasterEntity> findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(UUID organisationId);

    List<PmsCompetencyMasterEntity> findByOrganisationIdAndIdIn(UUID organisationId, Collection<UUID> ids);

    boolean existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrue(UUID organisationId, String name);

    boolean existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrueAndIdNot(UUID organisationId, String name, UUID id);
}
